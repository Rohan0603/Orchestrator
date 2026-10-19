#define UNICODE
#define _UNICODE

#include <windows.h>
#include <jobapi2.h>

#include <chrono>
#include <cctype>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <algorithm>
#include <atomic>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr char protocolVersion[] = "orchestrator-job-v1";
std::mutex outputMutex;

std::string jsonEscape(const std::string& value) {
    std::string escaped;
    escaped.reserve(value.size() + 8);
    for (const char character : value) {
        switch (character) {
        case '\\': escaped += "\\\\"; break;
        case '"': escaped += "\\\""; break;
        case '\n': escaped += "\\n"; break;
        case '\r': escaped += "\\r"; break;
        case '\t': escaped += "\\t"; break;
        default: escaped += character; break;
        }
    }
    return escaped;
}

std::string jsonValue(const std::string& line, const std::string& key) {
    const std::string prefix = "\"" + key + "\":\"";
    const auto start = line.find(prefix);
    if (start == std::string::npos) return {};
    const auto valueStart = start + prefix.size();
    std::string value;
    bool escaped = false;
    for (size_t index = valueStart; index < line.size(); ++index) {
        const char character = line[index];
        if (escaped) {
            switch (character) {
            case 'n': value += '\n'; break;
            case 'r': value += '\r'; break;
            case 't': value += '\t'; break;
            default: value += character; break;
            }
            escaped = false;
        } else if (character == '\\') {
            escaped = true;
        } else if (character == '"') {
            return value;
        } else {
            value += character;
        }
    }
    return {};
}

bool parseJsonStrings(const std::string& value, std::vector<std::string>& values) {
    size_t index = 0;
    while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
    if (index >= value.size() || value[index++] != '[') return false;
    while (true) {
        while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
        if (index < value.size() && value[index] == ']') return true;
        if (index >= value.size() || value[index++] != '"') return false;
        std::string item;
        bool escaped = false;
        while (index < value.size()) {
            const char character = value[index++];
            if (escaped) {
                item += character == 'n' ? '\n' : character == 'r' ? '\r' : character == 't' ? '\t' : character;
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (character == '"') {
                break;
            } else {
                item += character;
            }
        }
        values.push_back(item);
        while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
        if (index >= value.size()) return false;
        if (value[index] == ',') {
            ++index;
            continue;
        }
        return value[index] == ']' && ++index;
    }
}

bool parseJsonEnvironment(const std::string& value, std::map<std::string, std::string>& environment) {
    size_t index = 0;
    while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
    if (index >= value.size() || value[index++] != '{') return false;
    while (true) {
        while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
        if (index < value.size() && value[index] == '}') return true;
        if (index >= value.size() || value[index++] != '"') return false;
        std::string key;
        while (index < value.size() && value[index] != '"') key += value[index++];
        if (index >= value.size() || value[index++] != '"') return false;
        while (index < value.size() && (std::isspace(static_cast<unsigned char>(value[index])) || value[index] == ':')) ++index;
        if (index >= value.size() || value[index++] != '"') return false;
        std::string item;
        bool escaped = false;
        while (index < value.size()) {
            const char character = value[index++];
            if (escaped) {
                item += character == 'n' ? '\n' : character == 'r' ? '\r' : character == 't' ? '\t' : character;
                escaped = false;
            } else if (character == '\\') {
                escaped = true;
            } else if (character == '"') {
                break;
            } else {
                item += character;
            }
        }
        environment[key] = item;
        while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index]))) ++index;
        if (index >= value.size()) return false;
        if (value[index] == ',') {
            ++index;
            continue;
        }
        return value[index] == '}' && ++index;
    }
}

bool hasField(const std::string& line, const std::string& key, const std::string& value) {
    return jsonValue(line, key) == value;
}

std::string processCreationTime(HANDLE process) {
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return {};
    ULARGE_INTEGER value{};
    value.LowPart = created.dwLowDateTime;
    value.HighPart = created.dwHighDateTime;
    return std::to_string(value.QuadPart);
}

void reply(
    const std::string& id,
    const std::string& status,
    const std::string& detail = {},
    const std::string& fields = {}
) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << "{\"version\":\"" << protocolVersion << "\",\"id\":\"" << id
              << "\",\"status\":\"" << status << "\"";
    if (!detail.empty()) std::cout << ",\"detail\":\"" << jsonEscape(detail) << "\"";
    if (!fields.empty()) std::cout << "," << fields;
    std::cout << "}" << std::endl;
}

void event(
    const std::string& runId,
    const std::string& attemptId,
    const std::string& nonce,
    const char* stream,
    const std::string& data
) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << "{\"version\":\"" << protocolVersion
              << "\",\"event\":\"output\",\"runId\":\"" << jsonEscape(runId)
              << "\",\"attemptId\":\"" << jsonEscape(attemptId)
              << "\",\"nonce\":\"" << jsonEscape(nonce)
              << "\",\"stream\":\"" << stream
              << "\",\"data\":\"" << jsonEscape(data) << "\"}" << std::endl;
}

bool configureJob(HANDLE& job, const std::wstring& name) {
    job = CreateJobObjectW(nullptr, name.c_str());
    if (!job) return false;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(
            job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)
        )) {
        return true;
    }
    CloseHandle(job);
    job = nullptr;
    return false;
}
bool activeProcesses(HANDLE job, DWORD& count) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(
            job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr
        )) {
        return false;
    }
    count = accounting.ActiveProcesses;
    return true;
}

bool waitForEmpty(HANDLE job, DWORD timeoutMs) {
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    DWORD count = 0;
    while (std::chrono::steady_clock::now() < deadline) {
        if (!activeProcesses(job, count)) return false;
        if (count == 0) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return activeProcesses(job, count) && count == 0;
}

std::wstring quote(const std::wstring& value) {
    if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
        } else if (character == L'"') {
            result.append(backslashes * 2 + 1, L'\\');
            result += L'"';
            backslashes = 0;
        } else {
            result.append(backslashes, L'\\');
            backslashes = 0;
            result += character;
        }
    }
    result.append(backslashes * 2, L'\\');
    result += L'"';
    return result;
}

    std::wstring toWide(const std::string& value) {
        const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
        if (required <= 0) return {};
        std::wstring result(static_cast<size_t>(required), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, result.data(), required);
        result.resize(static_cast<size_t>(required - 1));
        return result;
    }

    bool pathIsAbsolute(const std::string& value) {
        const std::wstring wide = toWide(value);
        return !wide.empty() && fs::path(wide).is_absolute();
    }

    bool validEnvironment(const std::map<std::string, std::string>& environment) {
        size_t blockBytes = sizeof(wchar_t);
        if (environment.size() > 128) return false;
        for (const auto& [key, value] : environment) {
            if (key.empty() || key.size() > 128 || value.size() > 32768) return false;
            if (!std::isalpha(static_cast<unsigned char>(key.front())) && key.front() != '_') return false;
            for (const char character : key) {
                if (!std::isalnum(static_cast<unsigned char>(character)) && character != '_') return false;
            }
            blockBytes += (key.size() + value.size() + 2) * sizeof(wchar_t);
            if (blockBytes > 32768 * sizeof(wchar_t)) return false;
        }
        return true;
    }

    std::wstring modulePath() {
        std::vector<wchar_t> buffer(32768);
        const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        return length == 0 || length == buffer.size() ? std::wstring{} : std::wstring(buffer.data(), length);
    }

    bool writeMarker(const fs::path& directory, const wchar_t* name) {
        std::wofstream marker(directory / name, std::ios::trunc);
        if (!marker) return false;
        marker << GetCurrentProcessId() << L"\n";
        return static_cast<bool>(marker);
    }

    bool spawnFixture(const wchar_t* mode, const fs::path& directory, PROCESS_INFORMATION& process) {
        const std::wstring command = quote(modulePath()) + L" " + mode + L" " + quote(directory.wstring());
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        return CreateProcessW(
            nullptr, mutableCommand.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &process
        ) != FALSE;
    }

    int fixtureProcess(const wchar_t* mode, const fs::path& directory) {
        const wchar_t* marker = wcscmp(mode, L"--fixture-worker") == 0
            ? L"worker.started"
            : wcscmp(mode, L"--fixture-child") == 0 ? L"child.started" : L"grandchild.started";
        if (!writeMarker(directory, marker)) return 20;
        if (wcscmp(mode, L"--fixture-grandchild") != 0) {
            PROCESS_INFORMATION child{};
            const wchar_t* childMode = wcscmp(mode, L"--fixture-worker") == 0
                ? L"--fixture-child" : L"--fixture-grandchild";
            if (!spawnFixture(childMode, directory, child)) return 21;
            CloseHandle(child.hThread);
            CloseHandle(child.hProcess);
        }
        std::this_thread::sleep_for(std::chrono::seconds(30));
        return 0;
    }
class Owner {
public:
    ~Owner() {
        if (job_ != nullptr) {
            TerminateJobObject(job_, 1);
            waitForEmpty(job_, 5000);
        }
        if (outputThread_.joinable()) outputThread_.join();
        if (errorThread_.joinable()) errorThread_.join();
        if (outputRead_ != nullptr) CloseHandle(outputRead_);
        if (errorRead_ != nullptr) CloseHandle(errorRead_);
        if (recoveryEvent_ != nullptr) CloseHandle(recoveryEvent_);
        if (job_ != nullptr) CloseHandle(job_);
        if (worker_ != nullptr) {
            CloseHandle(worker_);
        }
    }

    bool launchCommand(
        const std::string& executable,
        const std::vector<std::string>& arguments,
        const std::string& workingDirectory,
        const std::map<std::string, std::string>& environment,
        const std::string& runId,
        const std::string& attemptId,
        const std::string& nonce
    ) {
        if (job_ != nullptr || executable.empty() || runId.empty() || attemptId.empty() || nonce.empty()) {
            return false;
        }
        std::error_code filesystemError;
        if (!pathIsAbsolute(executable) || !pathIsAbsolute(workingDirectory) ||
            !fs::is_regular_file(fs::path(toWide(executable)), filesystemError) ||
            filesystemError || !fs::is_directory(fs::path(toWide(workingDirectory)), filesystemError) ||
            filesystemError || !validEnvironment(environment)) {
            return false;
        }
        if (arguments.size() > 128) return false;
        for (const auto& argument : arguments) {
            if (argument.size() > 8192) return false;
        }
        const std::wstring jobName = toWide("OrchestratorJob-" + runId + "-" + attemptId + "-" + nonce);
        const std::wstring eventName = toWide("OrchestratorRecovery-" + runId + "-" + attemptId + "-" + nonce);
        if (jobName.empty() || !configureJob(job_, jobName)) return false;
        recoveryEvent_ = CreateEventW(nullptr, TRUE, FALSE, eventName.c_str());
        if (recoveryEvent_ == nullptr) {
            CloseHandle(job_);
            job_ = nullptr;
            return false;
        }

        SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE outputWrite = nullptr;
        HANDLE errorWrite = nullptr;
        if (!CreatePipe(&outputRead_, &outputWrite, &attributes, 0) ||
            !CreatePipe(&errorRead_, &errorWrite, &attributes, 0)) {
            if (outputRead_ != nullptr) CloseHandle(outputRead_);
            if (errorRead_ != nullptr) CloseHandle(errorRead_);
            outputRead_ = nullptr;
            errorRead_ = nullptr;
            CloseHandle(recoveryEvent_);
            recoveryEvent_ = nullptr;
            CloseHandle(job_);
            job_ = nullptr;
            return false;
        }
        SetHandleInformation(outputRead_, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(errorRead_, HANDLE_FLAG_INHERIT, 0);

        const std::wstring wideExecutable = toWide(executable);
        std::wstring command = quote(wideExecutable);
        for (const auto& argument : arguments) command += L" " + quote(toWide(argument));
        std::vector<wchar_t> mutableCommand(command.begin(), command.end());
        mutableCommand.push_back(L'\0');
        std::vector<std::pair<std::string, std::string>> orderedEnvironment(
            environment.begin(), environment.end()
        );
        std::sort(
            orderedEnvironment.begin(),
            orderedEnvironment.end(),
            [](const auto& left, const auto& right) {
                const auto fold = [](unsigned char character) {
                    return static_cast<unsigned char>(std::tolower(character));
                };
                return std::lexicographical_compare(
                    left.first.begin(), left.first.end(),
                    right.first.begin(), right.first.end(),
                    [&](char a, char b) { return fold(static_cast<unsigned char>(a)) < fold(static_cast<unsigned char>(b)); }
                );
            }
        );
        std::vector<wchar_t> environmentBlock;
        for (const auto& [key, value] : orderedEnvironment) {
            const std::wstring entry = toWide(key + "=" + value);
            environmentBlock.insert(environmentBlock.end(), entry.begin(), entry.end());
            environmentBlock.push_back(L'\0');
        }
        environmentBlock.push_back(L'\0');

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = nullptr;
        startup.StartupInfo.hStdOutput = outputWrite;
        startup.StartupInfo.hStdError = errorWrite;
        HANDLE inheritedHandles[] = {outputWrite, errorWrite};
        SIZE_T attributeBytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
        startup.lpAttributeList = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
            HeapAlloc(GetProcessHeap(), 0, attributeBytes)
        );
        if (startup.lpAttributeList == nullptr ||
            !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes) ||
            !UpdateProcThreadAttribute(
                startup.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                inheritedHandles,
                sizeof(inheritedHandles),
                nullptr,
                nullptr
            )) {
            if (startup.lpAttributeList != nullptr) {
                DeleteProcThreadAttributeList(startup.lpAttributeList);
                HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
            }
            CloseHandle(outputWrite);
            CloseHandle(errorWrite);
            CloseHandle(outputRead_);
            CloseHandle(errorRead_);
            outputRead_ = nullptr;
            errorRead_ = nullptr;
            return false;
        }
        PROCESS_INFORMATION process{};
        const BOOL created = CreateProcessW(
            wideExecutable.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
                EXTENDED_STARTUPINFO_PRESENT,
            environmentBlock.empty() ? nullptr : environmentBlock.data(),
            toWide(workingDirectory).c_str(), &startup.StartupInfo, &process
        );
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
        CloseHandle(outputWrite);
        CloseHandle(errorWrite);
        if (!created) {
            CloseHandle(outputRead_);
            CloseHandle(errorRead_);
            outputRead_ = nullptr;
            errorRead_ = nullptr;
            return false;
        }
        worker_ = process.hProcess;
        if (!AssignProcessToJobObject(job_, worker_)) {
            TerminateProcess(worker_, 1);
            WaitForSingleObject(worker_, 5000);
            CloseHandle(process.hThread);
            CloseHandle(worker_);
            worker_ = nullptr;
            return false;
        }
        BOOL inJob = FALSE;
        if (!IsProcessInJob(worker_, job_, &inJob) || !inJob ||
            ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
            TerminateJobObject(job_, 1);
            WaitForSingleObject(worker_, 5000);
            CloseHandle(process.hThread);
            CloseHandle(worker_);
            worker_ = nullptr;
            return false;
        }
        CloseHandle(process.hThread);
        runId_ = runId;
        attemptId_ = attemptId;
        nonce_ = nonce;
        creationTime_ = processCreationTime(worker_);
        outputDrained_ = false;
        errorDrained_ = false;
        outputThread_ = std::thread([this] { readOutput(outputRead_, "stdout"); });
        errorThread_ = std::thread([this] { readOutput(errorRead_, "stderr"); });
        return true;
    }

    bool launch(
        const std::string& executable,
        const std::string& runId,
        const std::string& attemptId,
        const std::string& nonce,
        const std::string& fixtureDirectory = {}
    ) {
        if (!fixtureDirectory.empty() &&
            (!pathIsAbsolute(fixtureDirectory) ||
             !fs::is_directory(fs::path(toWide(fixtureDirectory))))) {
            return false;
        }
        std::vector<std::string> arguments;
        if (!fixtureDirectory.empty()) {
            arguments = {"--fixture-worker", fixtureDirectory};
        }
        std::map<std::string, std::string> environment;
        char systemRoot[32768]{};
        const DWORD length = GetEnvironmentVariableA("SystemRoot", systemRoot, sizeof(systemRoot));
        if (length > 0 && length < sizeof(systemRoot)) environment.emplace("SystemRoot", systemRoot);
        return launchCommand(
            executable,
            arguments,
            fs::path(toWide(executable)).parent_path().string(),
            environment,
            runId,
            attemptId,
            nonce
        );
    }

    bool matches(const std::string& runId, const std::string& attemptId, const std::string& nonce) const {
        return runId == runId_ && attemptId == attemptId_ && nonce == nonce_;
    }

    bool cancel(const std::string& runId, const std::string& attemptId, const std::string& nonce) {
        if (!matches(runId, attemptId, nonce)) return false;
        if (job_ == nullptr) return false;
        if (!TerminateJobObject(job_, 1)) return false;
        const bool cleaned = waitForEmpty(job_, 5000);
        if (cleaned && recoveryEvent_ != nullptr) SetEvent(recoveryEvent_);
        return cleaned;
    }

    bool attach(
        const std::string& runId,
        const std::string& attemptId,
        const std::string& nonce,
        DWORD expectedPid,
        const std::string& expectedCreationTime
    ) {
        if (job_ != nullptr || runId.empty() || attemptId.empty() || nonce.empty() ||
            expectedPid == 0 || expectedCreationTime.empty()) {
            return false;
        }
        const std::wstring jobName = toWide("OrchestratorJob-" + runId + "-" + attemptId + "-" + nonce);
        const std::wstring eventName = toWide("OrchestratorRecovery-" + runId + "-" + attemptId + "-" + nonce);
        job_ = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, jobName.c_str());
        if (job_ == nullptr) {
            attachError_ = "job_open_failed:" + std::to_string(GetLastError());
            return false;
        }
        recoveryEvent_ = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, eventName.c_str());
        if (recoveryEvent_ == nullptr) {
            attachError_ = "recovery_event_open_failed:" + std::to_string(GetLastError());
            CloseHandle(job_);
            job_ = nullptr;
            return false;
        }
        HANDLE worker = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
            FALSE,
            expectedPid
        );
        if (worker == nullptr || processCreationTime(worker) != expectedCreationTime) {
            attachError_ = worker == nullptr ? "worker_open_failed:" + std::to_string(GetLastError()) : "worker_identity_mismatch";
            if (worker != nullptr) CloseHandle(worker);
            CloseHandle(recoveryEvent_);
            recoveryEvent_ = nullptr;
            CloseHandle(job_);
            job_ = nullptr;
            return false;
        }
        BOOL inJob = FALSE;
        if (!IsProcessInJob(worker, job_, &inJob) || !inJob) {
            attachError_ = "worker_not_in_job";
            CloseHandle(worker);
            CloseHandle(recoveryEvent_);
            recoveryEvent_ = nullptr;
            CloseHandle(job_);
            job_ = nullptr;
            return false;
        }
        worker_ = worker;
        runId_ = runId;
        attemptId_ = attemptId;
        nonce_ = nonce;
        creationTime_ = expectedCreationTime;
        outputDrained_ = true;
        errorDrained_ = true;
        return true;
    }

    bool shutdown() {
        if (job_ == nullptr) {
            if (recoveryEvent_ != nullptr) SetEvent(recoveryEvent_);
            return true;
        }
        const bool stopped = TerminateJobObject(job_, 1) != FALSE && waitForEmpty(job_, 5000);
        if (stopped && recoveryEvent_ != nullptr) SetEvent(recoveryEvent_);
        return stopped;
    }

    void waitForRecovery() const {
        if (recoveryEvent_ != nullptr) WaitForSingleObject(recoveryEvent_, 120000);
    }

    bool running() const {
        return worker_ != nullptr && WaitForSingleObject(worker_, 0) == WAIT_TIMEOUT;
    }

    bool activeCount(DWORD& count) const {
        return job_ != nullptr && activeProcesses(job_, count);
    }

    bool outputDrained() const {
        return outputDrained_.load() && errorDrained_.load();
    }

    DWORD exitCode() const {
        DWORD code = STILL_ACTIVE;
        if (worker_ != nullptr) GetExitCodeProcess(worker_, &code);
        return code;
    }

    const std::string& runId() const { return runId_; }
    const std::string& attemptId() const { return attemptId_; }
    const std::string& nonce() const { return nonce_; }
    DWORD workerPid() const { return worker_ == nullptr ? 0 : GetProcessId(worker_); }
    const std::string& workerCreationTime() const { return creationTime_; }
    const std::string& attachError() const { return attachError_; }

private:
    void readOutput(HANDLE pipe, const char* stream) {
        char buffer[4096];
        DWORD bytes = 0;
        while (pipe != nullptr && ReadFile(pipe, buffer, sizeof(buffer), &bytes, nullptr) && bytes > 0) {
            event(runId_, attemptId_, nonce_, stream, std::string(buffer, bytes));
        }
        if (std::string(stream) == "stdout") {
            outputDrained_ = true;
        } else {
            errorDrained_ = true;
        }
    }

    HANDLE job_ = nullptr;
    HANDLE worker_ = nullptr;
    HANDLE recoveryEvent_ = nullptr;
    HANDLE outputRead_ = nullptr;
    HANDLE errorRead_ = nullptr;
    std::thread outputThread_;
    std::thread errorThread_;
    std::string runId_;
    std::string attemptId_;
    std::string nonce_;
    std::string creationTime_;
    std::string attachError_;
    std::atomic<bool> outputDrained_{true};
    std::atomic<bool> errorDrained_{true};
};

} // namespace

int wmain(int argc, wchar_t** argv) {
    if (
        argc == 3 &&
        (wcscmp(argv[1], L"--fixture-worker") == 0 ||
         wcscmp(argv[1], L"--fixture-child") == 0 ||
         wcscmp(argv[1], L"--fixture-grandchild") == 0)
    ) {
        return fixtureProcess(argv[1], fs::path(argv[2]));
    }
    Owner owner;
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.size() > 8192) {
            reply("", "error", "message_too_large");
            continue;
        }
        const auto id = jsonValue(line, "id");
        if (jsonValue(line, "version") != protocolVersion || id.empty()) {
            reply(id, "error", "invalid_protocol");
            continue;
        }
        const auto operation = jsonValue(line, "operation");
        if (operation == "handshake") {
            reply(
                id,
                "ok",
                {},
                "\"helperPid\":" + std::to_string(GetCurrentProcessId()) +
                    ",\"helperCreationTime\":\"" + processCreationTime(GetCurrentProcess()) + "\""
            );
        } else if (operation == "launch") {
            const auto runId = jsonValue(line, "runId");
            const auto attemptId = jsonValue(line, "attemptId");
            const auto nonce = jsonValue(line, "nonce");
            const auto fixtureDirectory = jsonValue(line, "fixtureDirectory");
            const auto executable = jsonValue(line, "executable");
            const auto argumentsJson = jsonValue(line, "arguments");
            const auto workingDirectory = jsonValue(line, "workingDirectory");
            const auto environmentJson = jsonValue(line, "environment");
            std::vector<std::string> arguments;
            std::map<std::string, std::string> environment;
            const bool genericRequest =
                !argumentsJson.empty() || !workingDirectory.empty() || !environmentJson.empty();
            const bool parsed = !genericRequest ||
                (parseJsonStrings(argumentsJson, arguments) &&
                 parseJsonEnvironment(environmentJson, environment));
            const bool launched = genericRequest
                ? parsed && owner.launchCommand(
                    executable, arguments, workingDirectory, environment, runId, attemptId, nonce
                )
                : owner.launch(executable, runId, attemptId, nonce, fixtureDirectory);
            if (launched) {
                reply(
                    id,
                    "running",
                    {},
                    "\"runId\":\"" + runId + "\",\"attemptId\":\"" + attemptId +
                        "\",\"nonce\":\"" + nonce +
                        "\",\"ownershipVerified\":true,\"workerExecutedBeforeOwnership\":false" +
                        ",\"workerPid\":" + std::to_string(owner.workerPid()) +
                        ",\"workerCreationTime\":\"" + owner.workerCreationTime() + "\""
                );
            } else {
                reply(id, "error", "ownership_or_launch_failed");
            }
        } else if (operation == "reconcile") {
            const auto runId = jsonValue(line, "runId");
            const auto attemptId = jsonValue(line, "attemptId");
            const auto nonce = jsonValue(line, "nonce");
            const auto workerPidValue = jsonValue(line, "workerPid");
            const auto workerCreationTime = jsonValue(line, "workerCreationTime");
            char* end = nullptr;
            const unsigned long workerPid = std::strtoul(workerPidValue.c_str(), &end, 10);
            const bool attached = end != workerPidValue.c_str() && *end == '\0' &&
                owner.attach(runId, attemptId, nonce, static_cast<DWORD>(workerPid), workerCreationTime);
            if (!attached) {
                reply(id, "error", owner.attachError().empty()
                    ? "ownership_reconciliation_unverified"
                    : owner.attachError());
                continue;
            }
            DWORD active = 0;
            const bool counted = owner.activeCount(active);
            reply(
                id,
                counted && owner.running() ? "running" : "idle",
                {},
                "\"runId\":\"" + runId + "\",\"attemptId\":\"" + attemptId +
                    "\",\"nonce\":\"" + nonce +
                    "\",\"ownershipVerified\":true" +
                    ",\"activeProcessesKnown\":" + (counted ? "true" : "false") +
                    (counted ? ",\"activeProcesses\":" + std::to_string(active) : ",\"activeProcesses\":null") +
                    ",\"outputDrained\":true" +
                    ",\"workerPid\":" + std::to_string(owner.workerPid()) +
                    ",\"workerCreationTime\":\"" + owner.workerCreationTime() + "\"" +
                    ",\"exitCode\":" + std::to_string(owner.exitCode())
            );
        } else if (operation == "cancel") {
            const bool terminated = owner.cancel(
                jsonValue(line, "runId"), jsonValue(line, "attemptId"), jsonValue(line, "nonce")
            );
            DWORD active = 0;
            const bool counted = owner.activeCount(active);
            const bool cleaned = terminated && counted && active == 0;
            reply(
                id,
                cleaned ? "cleanup_verified" : "error",
                cleaned ? "" : "cleanup_unverified",
                std::string("\"activeProcessesKnown\":") + (counted ? "true" : "false") +
                    (counted ? ",\"activeProcesses\":" + std::to_string(active) : ",\"activeProcesses\":null")
            );
        } else if (operation == "shutdown") {
            const bool shutdown = owner.shutdown();
            reply(id, shutdown ? "ok" : "error", shutdown ? "" : "shutdown_failed");
            if (shutdown) break;
        } else if (operation == "status") {
            DWORD active = 0;
            const bool counted = owner.activeCount(active);
            reply(
                id,
                owner.running() ? "running" : "idle",
                {},
                "\"runId\":\"" + owner.runId() + "\",\"attemptId\":\"" + owner.attemptId() +
                    "\",\"nonce\":\"" + owner.nonce() +
                    "\"" +
                    ",\"activeProcessesKnown\":" + (counted ? "true" : "false") +
                    (counted ? ",\"activeProcesses\":" + std::to_string(active) : ",\"activeProcesses\":null") +
                    ",\"outputDrained\":" + (owner.outputDrained() ? "true" : "false") +
                    ",\"workerPid\":" + std::to_string(owner.workerPid()) +
                    ",\"workerCreationTime\":\"" + owner.workerCreationTime() + "\"" +
                    ",\"exitCode\":" + std::to_string(owner.exitCode())
            );
        } else {
            reply(id, "error", "unknown_operation");
        }
    }
    owner.waitForRecovery();
    return 0;
}
