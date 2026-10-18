#define UNICODE
#define _UNICODE

#include <windows.h>
#include <jobapi2.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace {

using namespace std::chrono_literals;

std::wstring quote(const std::wstring& value) {
    std::wstring result = L"\"";
    for (wchar_t character : value) {
        if (character == L'"') result += L'\\';
        result += character;
    }
    result += L"\"";
    return result;
}

std::wstring executablePath() {
    std::vector<wchar_t> buffer(32768);
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length == buffer.size()) return {};
    return {buffer.data(), length};
}

bool writeMarker(const fs::path& directory, const wchar_t* name) {
    std::wofstream file(directory / name, std::ios::trunc);
    if (!file) return false;
    file << GetCurrentProcessId() << L"\n";
    return static_cast<bool>(file);
}

bool markerPid(const fs::path& directory, const wchar_t* name, DWORD& pid) {
    std::wifstream file(directory / name);
    if (!file) return false;
    return static_cast<bool>(file >> pid);
}

bool waitForMarker(const fs::path& directory, const wchar_t* name, DWORD& pid, DWORD timeoutMs) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (markerPid(directory, name, pid)) return true;
        std::this_thread::sleep_for(10ms);
    }
    return markerPid(directory, name, pid);
}

bool spawnChild(const std::wstring& mode, const fs::path& directory, PROCESS_INFORMATION& process) {
    const std::wstring commandLine =
        quote(executablePath()) + L" " + mode + L" " + quote(directory.wstring());
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    return CreateProcessW(
        nullptr,
        mutableCommand.data(),
        nullptr,
        nullptr,
        FALSE,
        0,
        nullptr,
        nullptr,
        &startup,
        &process
    ) != FALSE;
}

int worker(const fs::path& directory, const wchar_t* childMode, const wchar_t* marker) {
    if (!writeMarker(directory, marker)) return 20;
    PROCESS_INFORMATION child{};
    if (!spawnChild(childMode, directory, child)) return 21;
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    std::this_thread::sleep_for(30s);
    return 0;
}

bool processInJob(HANDLE process, HANDLE job) {
    BOOL inJob = FALSE;
    return IsProcessInJob(process, job, &inJob) != FALSE && inJob != FALSE;
}

bool activeProcesses(HANDLE job, DWORD& count) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            &accounting,
            sizeof(accounting),
            nullptr
        )) {
        return false;
    }
    count = accounting.ActiveProcesses;
    return true;
}

bool waitForActiveCount(HANDLE job, DWORD expected, DWORD timeoutMs, DWORD& observed) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (!activeProcesses(job, observed)) return false;
        if (observed == expected) return true;
        std::this_thread::sleep_for(10ms);
    }
    return activeProcesses(job, observed) && observed == expected;
}

void closeProcess(HANDLE& process) {
    if (process != nullptr) {
        CloseHandle(process);
        process = nullptr;
    }
}

bool createConfiguredJob(HANDLE& job) {
    job = CreateJobObjectW(nullptr, nullptr);
    if (job == nullptr) return false;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits)
        )) {
        return true;
    }
    CloseHandle(job);
    job = nullptr;
    return false;
}

bool createSuspendedProbe(const fs::path& directory, PROCESS_INFORMATION& process) {
    const std::wstring commandLine =
        quote(executablePath()) + L" --grandchild " + quote(directory.wstring());
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    return CreateProcessW(
        nullptr,
        mutableCommand.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_SUSPENDED,
        nullptr,
        nullptr,
        &startup,
        &process
    ) != FALSE;
}

int failureTests() {
    const fs::path directory =
        fs::temp_directory_path() / (L"orchestrator-job-failures-" + std::to_wstring(GetCurrentProcessId()));
    fs::remove_all(directory);
    fs::create_directories(directory);
    int failures = 0;

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool jobReady = createConfiguredJob(job);
        std::wstring invalidCommand = L"Z:\\orchestrator-no-such-worker.exe";
        std::vector<wchar_t> command(invalidCommand.begin(), invalidCommand.end());
        command.push_back(L'\0');
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        const bool created = jobReady && CreateProcessW(
            nullptr,
            command.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_SUSPENDED,
            nullptr,
            nullptr,
            &startup,
            &process
        );
        if (created) {
            TerminateProcess(process.hProcess, 99);
            WaitForSingleObject(process.hProcess, 5000);
            closeProcess(process.hThread);
            closeProcess(process.hProcess);
            ++failures;
        }
        closeProcess(job);
        std::wcout << L"process_creation_failure=" << (!created) << L" failures=" << failures << L"\n";
    }

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool ready = createConfiguredJob(job) && createSuspendedProbe(directory, process);
        const BOOL assigned = ready && AssignProcessToJobObject(nullptr, process.hProcess);
        if (!ready || assigned) ++failures;
        if (process.hProcess != nullptr) {
            TerminateProcess(process.hProcess, 99);
            WaitForSingleObject(process.hProcess, 5000);
        }
        closeProcess(process.hThread);
        closeProcess(process.hProcess);
        closeProcess(job);
        std::wcout << L"assignment_failure_cleanup=" << (!assigned && ready) << L" failures=" << failures << L"\n";
    }

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool ready = createConfiguredJob(job) && createSuspendedProbe(directory, process);
        const bool assigned = ready && AssignProcessToJobObject(job, process.hProcess) != FALSE;
        if (!assigned) ++failures;
        if (ready) {
            HANDLE closedJob = job;
            CloseHandle(job);
            job = nullptr;
            DWORD queryCount = 0;
            const bool queryFailed = !activeProcesses(closedJob, queryCount);
            if (!queryFailed) ++failures;
            WaitForSingleObject(process.hProcess, 5000);
        }
        closeProcess(process.hThread);
        closeProcess(process.hProcess);
        closeProcess(job);
        std::wcout << L"active_query_failure_after_owner_close=" << (assigned) << L" failures=" << failures << L"\n";
    }

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool ready = createConfiguredJob(job) && createSuspendedProbe(directory, process);
        const bool assigned = ready && AssignProcessToJobObject(job, process.hProcess) != FALSE;
        const bool injectedResumeFailure = assigned;
        if (!injectedResumeFailure || !TerminateJobObject(job, 99)) ++failures;
        if (process.hProcess != nullptr) WaitForSingleObject(process.hProcess, 5000);
        closeProcess(process.hThread);
        closeProcess(process.hProcess);
        closeProcess(job);
        std::wcout << L"injected_resume_failure_cleanup=" << injectedResumeFailure << L" failures=" << failures << L"\n";
    }

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool ready = createConfiguredJob(job) && createSuspendedProbe(directory, process);
        const bool assigned = ready && AssignProcessToJobObject(job, process.hProcess) != FALSE;
        const bool terminated = assigned && TerminateJobObject(job, 77) != FALSE;
        DWORD active = 99;
        const bool zero = terminated && WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0 &&
            activeProcesses(job, active) && active == 0;
        const BOOL repeated = terminated ? TerminateJobObject(job, 77) : FALSE;
        if (!zero) ++failures;
        closeProcess(process.hThread);
        closeProcess(process.hProcess);
        closeProcess(job);
        std::wcout << L"repeated_termination_zero_active=" << zero
                   << L" repeated_request_result=" << (repeated != FALSE)
                   << L" failures=" << failures << L"\n";
    }

    {
        HANDLE job = nullptr;
        PROCESS_INFORMATION process{};
        const bool ready = createConfiguredJob(job) && createSuspendedProbe(directory, process);
        const bool assigned = ready && AssignProcessToJobObject(job, process.hProcess) != FALSE;
        if (!assigned) ++failures;
        if (assigned) {
            CloseHandle(job);
            job = nullptr;
            if (WaitForSingleObject(process.hProcess, 5000) != WAIT_OBJECT_0) ++failures;
        }
        closeProcess(process.hThread);
        closeProcess(process.hProcess);
        closeProcess(job);
        std::wcout << L"owner_close_cleanup=" << assigned << L" failures=" << failures << L"\n";
    }

    fs::remove_all(directory);
    std::wcout << L"failure_tests_failed=" << failures << L"\n";
    return failures == 0 ? 0 : 40;
}

int containmentTest() {
    const fs::path directory =
        fs::temp_directory_path() / (L"orchestrator-job-object-" + std::to_wstring(GetCurrentProcessId()));
    fs::remove_all(directory);
    fs::create_directories(directory);

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    HANDLE workerProcess = nullptr;
    HANDLE childProcess = nullptr;
    HANDLE grandchildProcess = nullptr;
    PROCESS_INFORMATION workerInfo{};
    DWORD workerPid = 0;
    DWORD childPid = 0;
    DWORD grandchildPid = 0;
    DWORD active = 0;
    bool workerInJob = false;
    bool childInJob = false;
    bool grandchildInJob = false;
    bool assigned = false;
    bool success = false;

    if (job == nullptr) {
        std::wcerr << L"CreateJobObjectW failed error=" << GetLastError() << L"\n";
        return 30;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits,
            sizeof(limits)
        )) {
        std::wcerr << L"SetInformationJobObject failed error=" << GetLastError() << L"\n";
        CloseHandle(job);
        return 31;
    }

    const std::wstring commandLine =
        quote(executablePath()) + L" --worker " + quote(directory.wstring());
    std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
    mutableCommand.push_back(L'\0');
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(
            nullptr,
            mutableCommand.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_SUSPENDED,
            nullptr,
            nullptr,
            &startup,
            &workerInfo
        )) {
        std::wcerr << L"CreateProcessW suspended failed error=" << GetLastError() << L"\n";
        CloseHandle(job);
        return 32;
    }
    workerProcess = workerInfo.hProcess;
    std::wcout << L"worker_pid=" << workerInfo.dwProcessId << L"\n";

    if (fs::exists(directory / L"worker.started")) {
        std::wcerr << L"worker executed before resume\n";
        goto cleanup;
    }

    if (!AssignProcessToJobObject(job, workerProcess)) {
        std::wcerr << L"AssignProcessToJobObject failed error=" << GetLastError() << L"\n";
        goto cleanup;
    }
    assigned = true;
    if (!processInJob(workerProcess, job)) {
        std::wcerr << L"worker membership verification failed\n";
        goto cleanup;
    }
    if (!activeProcesses(job, active) || active != 1) {
        std::wcerr << L"pre-resume active count invalid count=" << active << L"\n";
        goto cleanup;
    }
    std::wcout << L"assigned_before_execution=true pre_resume_active=" << active << L"\n";

    if (ResumeThread(workerInfo.hThread) == static_cast<DWORD>(-1)) {
        std::wcerr << L"ResumeThread failed error=" << GetLastError() << L"\n";
        goto cleanup;
    }
    CloseHandle(workerInfo.hThread);
    workerInfo.hThread = nullptr;
    if (!waitForMarker(directory, L"worker.started", workerPid, 5000) ||
        !waitForMarker(directory, L"child.started", childPid, 5000) ||
        !waitForMarker(directory, L"grandchild.started", grandchildPid, 5000)) {
        std::wcerr << L"worker descendant markers not observed\n";
        goto cleanup;
    }

    childProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, childPid);
    grandchildProcess = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, grandchildPid);
    workerInJob = processInJob(workerProcess, job);
    childInJob = childProcess != nullptr && processInJob(childProcess, job);
    grandchildInJob = grandchildProcess != nullptr && processInJob(grandchildProcess, job);
    if (childProcess == nullptr || grandchildProcess == nullptr || !workerInJob || !childInJob || !grandchildInJob) {
        std::wcerr << L"descendant membership verification failed"
                   << L" child_handle=" << (childProcess != nullptr)
                   << L" grandchild_handle=" << (grandchildProcess != nullptr)
                   << L" worker_in_job=" << workerInJob
                   << L" child_in_job=" << childInJob
                   << L" grandchild_in_job=" << grandchildInJob << L"\n";
        goto cleanup;
    }
    if (!activeProcesses(job, active) || active < 3) {
        std::wcerr << L"active descendant count invalid count=" << active << L"\n";
        goto cleanup;
    }
    std::wcout << L"worker_pid=" << workerPid
               << L" child_pid=" << childPid
               << L" grandchild_pid=" << grandchildPid
               << L" contained=true active_before_termination=" << active << L"\n";

    if (!TerminateJobObject(job, 77)) {
        std::wcerr << L"TerminateJobObject failed error=" << GetLastError() << L"\n";
        goto cleanup;
    }
    if (WaitForSingleObject(workerProcess, 5000) != WAIT_OBJECT_0 ||
        WaitForSingleObject(childProcess, 5000) != WAIT_OBJECT_0 ||
        WaitForSingleObject(grandchildProcess, 5000) != WAIT_OBJECT_0) {
        std::wcerr << L"owned processes did not exit after job termination\n";
        goto cleanup;
    }
    if (!waitForActiveCount(job, 0, 5000, active)) {
        std::wcerr << L"active-process verification failed after termination count=" << active << L"\n";
        goto cleanup;
    }
    std::wcout << L"terminated_owned_job=true active_after_termination=" << active
               << L" processes_exited=true\n";
    success = true;

cleanup:
    if (!success && job != nullptr) {
        if (assigned) {
            TerminateJobObject(job, 99);
        } else if (workerProcess != nullptr) {
            TerminateProcess(workerProcess, 99);
        }
    }
    if (workerProcess != nullptr) WaitForSingleObject(workerProcess, 5000);
    if (childProcess != nullptr) WaitForSingleObject(childProcess, 5000);
    if (grandchildProcess != nullptr) WaitForSingleObject(grandchildProcess, 5000);
    closeProcess(workerInfo.hThread);
    closeProcess(grandchildProcess);
    closeProcess(childProcess);
    closeProcess(workerProcess);
    if (job != nullptr) CloseHandle(job);
    fs::remove_all(directory);
    return success ? 0 : 33;
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
    if (argc >= 2 && std::wstring(argv[1]) == L"--failure-tests") {
        return failureTests();
    }
    if (argc >= 3 && std::wstring(argv[1]) == L"--worker") {
        return worker(argv[2], L"--child", L"worker.started");
    }
    if (argc >= 3 && std::wstring(argv[1]) == L"--child") {
        return worker(argv[2], L"--grandchild", L"child.started");
    }
    if (argc >= 3 && std::wstring(argv[1]) == L"--grandchild") {
        if (!writeMarker(argv[2], L"grandchild.started")) return 22;
        std::this_thread::sleep_for(30s);
        return 0;
    }
    return containmentTest();
}
