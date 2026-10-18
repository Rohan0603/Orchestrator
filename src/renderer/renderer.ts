type Task = import("../shared/domain").Task;
type RunHistoryEntry = import("../shared/ipc").RunHistoryEntry;

type Page = "overview" | "tasks" | "diagnostics";
type RunData = readonly RunHistoryEntry[] | null;

const pendingFixtureRuns = new Set<string>();
let submittingTask = false;
let activePage: Page = "overview";
let selectedTaskId: string | null = null;
let tasks: readonly Task[] = [];
let runHistory = new Map<string, RunData>();
let loadError = "";
let statusText = "Loading application status...";
let runResultText = "";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(value: string): string {
  if (["accepted", "completed", "connected", "succeeded"].includes(value)) return "success";
  if (["blocked", "recovery_required", "unavailable", "failed", "rejected"].includes(value)) return "danger";
  if (["running", "verification", "pending"].includes(value)) return "warning";
  return "neutral";
}

function badge(value: string): HTMLSpanElement {
  return el("span", statusLabel(value), `badge ${statusTone(value)}`);
}

function clear(element: Element): void {
  element.replaceChildren();
}

function addText(parent: Element, label: string, value: string): void {
  const row = el("div", undefined, "detail-row");
  row.append(el("dt", label), el("dd", value));
  parent.append(row);
}

function latestEntry(taskId: string): RunHistoryEntry | undefined {
  return runHistory.get(taskId)?.[0];
}

async function loadData(): Promise<void> {
  loadError = "";
  try {
    const [statusResult, taskResult] = await Promise.all([
      window.orchestrator.getStatus(),
      window.orchestrator.listTasks()
    ]);
    statusText = statusResult.ok
      ? `Database: ${statusResult.value.database}`
      : `Error: ${statusResult.error.message}`;
    if (!taskResult.ok) {
      tasks = [];
      runHistory = new Map();
      loadError = taskResult.error.message;
      render();
      return;
    }
    tasks = taskResult.value;
    const history = await Promise.all(
      tasks.map(async (task) => {
        try {
          const result = await window.orchestrator.listRuns(task.id);
          return [task.id, result.ok ? result.value : null] as const;
        } catch {
          return [task.id, null] as const;
        }
      })
    );
    runHistory = new Map(history);
  } catch {
    loadError = "Unable to load persisted application data";
    statusText = "Error: Application unavailable";
  }
  render();
}

function renderNav(): HTMLElement {
  const nav = el("nav", undefined, "sidebar-nav");
  for (const [page, label] of [
    ["overview", "Overview"],
    ["tasks", "Tasks"],
    ["diagnostics", "Diagnostics"]
  ] as const) {
    const button = el("button", label, `nav-link${activePage === page ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("aria-current", activePage === page ? "page" : "false");
    button.addEventListener("click", () => {
      activePage = page;
      selectedTaskId = null;
      render();
    });
    nav.append(button);
  }
  return nav;
}

function renderOverview(): HTMLElement {
  const section = el("section", undefined, "page");
  section.append(
    el("p", "Workspace overview", "eyebrow"),
    el("h2", "Operate with evidence", "page-title"),
    el("p", "Persisted task and run state, without treating worker claims as acceptance.", "page-description")
  );
  const entries = [...runHistory.values()].flatMap((value) => value ?? []);
  const active = entries.filter(({ run }) =>
    ["running", "verification", "review", "repair", "recovery_required"].includes(run.state)
  ).length;
  const blocked = entries.filter(({ run }) => run.state === "recovery_required" || run.state === "blocked").length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const stats = el("div", undefined, "stats-grid");
  for (const [label, value, hint] of [
    ["Tasks", String(tasks.length), "Persisted task records"],
    ["Active runs", String(active), "Running or awaiting resolution"],
    ["Completed tasks", String(completed), "Task lifecycle state"],
    ["Recovery required", String(blocked), "Runs needing reconciliation"]
  ]) {
    const card = el("article", undefined, "stat-card");
    card.append(el("span", label, "stat-label"), el("strong", value, "stat-value"), el("span", hint, "stat-hint"));
    stats.append(card);
  }
  section.append(stats);
  const activity = el("article", undefined, "panel");
  activity.append(el("h3", "Recent activity"), el("p", entries.length === 0 ? "No runs recorded yet." : `${entries.length} persisted run record(s).`));
  const action = el("button", "Open tasks", "primary");
  action.type = "button";
  action.addEventListener("click", () => {
    activePage = "tasks";
    render();
  });
  activity.append(action);
  section.append(activity);
  return section;
}

function renderTaskForm(): HTMLElement {
  const panel = el("article", undefined, "panel");
  panel.append(
    el("h3", "Create task"),
    el("p", "Risk tier controls policy. Tier 1 is eligible for deterministic fixture execution only.", "muted")
  );
  const form = el("form");
  form.id = "task-form";
  const title = el("input");
  title.name = "title";
  title.maxLength = 200;
  title.required = true;
  title.placeholder = "Task title";
  title.setAttribute("aria-label", "Task title");
  const description = el("textarea");
  description.name = "description";
  description.maxLength = 10000;
  description.placeholder = "What needs to change?";
  description.setAttribute("aria-label", "Description");
  const criterion = el("textarea");
  criterion.name = "criterion";
  criterion.required = true;
  criterion.placeholder = "Acceptance criteria, one per line";
  criterion.setAttribute("aria-label", "Acceptance criteria");
  const risk = el("select");
  risk.name = "riskTier";
  for (const [value, label] of [["1", "Tier 1 — fixture eligible"], ["2", "Tier 2 — approval required"], ["3", "Tier 3 — stronger controls"]] as const) {
    risk.append(new Option(label, value));
  }
  for (const [label, control] of [["Title", title], ["Description", description], ["Acceptance criteria", criterion], ["Risk tier", risk]] as const) {
    const wrapper = el("label", undefined, "field");
    wrapper.append(el("span", label), control);
    form.append(wrapper);
  }
  const error = el("p", "", "inline-error");
  error.id = "task-error";
  error.setAttribute("role", "alert");
  const submit = el("button", "Create task", "primary");
  submit.type = "submit";
  form.append(submit, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submittingTask) return;
    const criteria = criterion.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!title.value.trim() || criteria.length === 0) {
      error.textContent = "Title and at least one acceptance criterion are required.";
      return;
    }
    submittingTask = true;
    submit.disabled = true;
    error.textContent = "";
    try {
      const result = await window.orchestrator.createTask({
        title: title.value,
        description: description.value,
        acceptanceCriteria: criteria,
        riskTier: Number(risk.value) as 1 | 2 | 3
      });
      if (!result.ok) {
        error.textContent = result.error.message;
        return;
      }
      form.reset();
      selectedTaskId = null;
      await loadData();
    } catch {
      error.textContent = "Task creation failed. Input was preserved.";
    } finally {
      submittingTask = false;
      submit.disabled = false;
    }
  });
  panel.append(form);
  return panel;
}

function renderTaskDetail(task: Task): HTMLElement {
  const section = el("section", undefined, "page");
  const back = el("button", "Back to tasks", "text-button");
  back.type = "button";
  back.addEventListener("click", () => {
    selectedTaskId = null;
    render();
  });
  section.append(back, el("p", "Task detail", "eyebrow"), el("h2", task.title, "page-title"));
  const header = el("div", undefined, "detail-header");
  header.append(badge(task.status), el("span", `Risk tier ${task.riskTier}`, "risk-label"));
  section.append(header);
  const info = el("dl", undefined, "detail-list");
  addText(info, "Description", task.description || "No description provided.");
  addText(info, "Created", new Date(task.createdAt).toLocaleString());
  section.append(info);
  const criteria = el("article", undefined, "panel");
  criteria.append(el("h3", "Acceptance criteria"));
  const list = el("ul", "");
  for (const criterion of task.acceptanceCriteria) list.append(el("li", criterion));
  criteria.append(list);
  section.append(criteria);
  const runs = el("article", undefined, "panel");
  runs.append(el("h3", "Runs and attempts"));
  const history = runHistory.get(task.id);
  if (!history) runs.append(el("p", "Run history unavailable.", "inline-error"));
  else if (history.length === 0) runs.append(el("p", "No runs recorded. Tier 1 tasks can use the labeled fixture action.", "muted"));
  else for (const entry of history) {
    const row = el("div", undefined, "run-row");
    row.append(badge(entry.run.state), el("span", `Attempt: ${statusLabel(entry.attempt.outcome)}`));
    if (entry.attempt.workerReport) row.append(el("p", entry.attempt.workerReport, "muted"));
    runs.append(row);
  }
  section.append(runs);
  return section;
}

function renderTasks(): HTMLElement {
  const section = el("section", undefined, "page");
  section.append(el("p", "Work queue", "eyebrow"), el("h2", "Tasks", "page-title"), el("p", "Create tasks, inspect durable lifecycle state and run only supported fixture actions.", "page-description"));
  section.append(renderTaskForm());
  const controls = el("div", undefined, "filter-bar");
  const search = el("input");
  search.id = "task-search";
  search.placeholder = "Search tasks";
  search.setAttribute("aria-label", "Search tasks");
  const status = el("select");
  status.id = "task-status-filter";
  status.setAttribute("aria-label", "Filter by status");
  status.append(new Option("All states", ""));
  for (const value of ["intake", "planned", "blocked", "completed"]) status.append(new Option(statusLabel(value), value));
  const risk = el("select");
  risk.id = "task-risk-filter";
  risk.setAttribute("aria-label", "Filter by risk tier");
  risk.append(new Option("All risk tiers", ""));
  for (const value of ["1", "2", "3"]) risk.append(new Option(`Risk tier ${value}`, value));
  controls.append(search, status, risk);
  section.append(controls);
  const list = el("div");
  list.id = "tasks";
  list.setAttribute("aria-live", "polite");
  const renderList = () => {
    clear(list);
    const filtered = tasks.filter((task) =>
      task.title.toLowerCase().includes(search.value.trim().toLowerCase()) &&
      (!status.value || task.status === status.value) &&
      (!risk.value || String(task.riskTier) === risk.value)
    );
    if (filtered.length === 0) {
      list.append(el("p", tasks.length === 0 ? "No tasks yet. Create one above." : "No tasks match current filters.", "empty-state"));
      return;
    }
    for (const task of filtered) {
      const card = el("article", undefined, "task-card");
      const heading = el("div", undefined, "task-heading");
      heading.append(el("h3", task.title), badge(task.status));
      card.append(heading, el("p", task.description || "No description provided.", "muted"));
      const meta = el("div", undefined, "task-meta");
      meta.append(el("span", `Risk ${task.riskTier}`));
      const latest = latestEntry(task.id);
      meta.append(el("span", latest ? `Latest attempt ${latest.attempt.outcome}` : "No runs"));
      card.append(meta);
      const actions = el("div", undefined, "task-actions");
      if (task.riskTier === 1) {
        const run = el("button", pendingFixtureRuns.has(task.id) ? "Running fixture..." : "Run local fixture", "secondary");
        run.type = "button";
        run.disabled = pendingFixtureRuns.has(task.id);
        run.addEventListener("click", async () => {
          if (pendingFixtureRuns.has(task.id)) return;
          pendingFixtureRuns.add(task.id);
          render();
          try {
            const result = await window.orchestrator.runFixture(task.id);
            const output = document.querySelector<HTMLParagraphElement>("#run-result");
            runResultText = result.ok
              ? `Run ${result.value.status}; accepted: ${result.value.accepted}; ${result.value.acceptance?.reason ?? "No acceptance decision recorded"}; progress: ${result.value.progressAccepted} accepted, ${result.value.progressRejected} rejected.`
              : `Run blocked: ${result.error.message}`;
            if (output) output.textContent = runResultText;
          } catch {
            const output = document.querySelector<HTMLParagraphElement>("#run-result");
            runResultText = "Run failed: Unable to execute fixture.";
            if (output) output.textContent = runResultText;
          } finally {
            pendingFixtureRuns.delete(task.id);
            await loadData();
          }
        });
        actions.append(run);
      } else {
        actions.append(el("span", "Fixture unavailable for this risk tier.", "muted"));
      }
      const open = el("button", "Open details", "text-button");
      open.type = "button";
      open.addEventListener("click", () => {
        selectedTaskId = task.id;
        render();
      });
      actions.append(open);
      card.append(actions);
      list.append(card);
    }
  };
  for (const control of [search, status, risk]) control.addEventListener("input", renderList);
  renderList();
  section.append(list, el("p", runResultText, "run-result"));
  const result = section.querySelector<HTMLParagraphElement>(".run-result");
  if (result) result.id = "run-result";
  return section;
}

function renderDiagnostics(): HTMLElement {
  const section = el("section", undefined, "page");
  section.append(el("p", "System", "eyebrow"), el("h2", "Diagnostics", "page-title"), el("p", "Read-only readiness information from the current application boundary.", "page-description"));
  const panel = el("article", undefined, "panel");
  panel.append(el("h3", "Persistence"), el("p", statusText, "status-line"));
  panel.append(el("p", "SQLite is authoritative for task, run, attempt, approval and recovery state.", "muted"));
  const worker = el("article", undefined, "panel");
  worker.append(el("h3", "Execution route"), badge("unverified"));
  worker.append(el("p", "The UI exposes deterministic local fixture execution only. Real provider execution, Windows process ownership and cancellation qualification are not enabled.", "muted"));
  const review = el("article", undefined, "panel");
  review.append(el("h3", "Acceptance"), badge("blocked"));
  review.append(el("p", "Fixture success cannot become acceptance while independent review and verified evidence are unavailable.", "muted"));
  section.append(panel, worker, review);
  return section;
}

function render(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return;
  clear(root);
  const shell = el("div", undefined, "shell");
  const sidebar = el("aside", undefined, "sidebar");
  sidebar.append(el("h1", "Orchestrator", "brand"), el("p", "Local development control plane", "sidebar-subtitle"), renderNav());
  sidebar.append(el("p", "Fixture mode only", "fixture-note"));
  const content = el("main", undefined, "content");
  const topbar = el("header", undefined, "topbar");
  const connection = el("span", statusText, "connection-status");
  connection.id = "status";
  topbar.append(connection);
  if (loadError) topbar.append(el("span", loadError, "inline-error"));
  content.append(topbar);
  if (selectedTaskId) {
    const task = tasks.find((candidate) => candidate.id === selectedTaskId);
    content.append(task ? renderTaskDetail(task) : el("p", "Task no longer exists.", "empty-state"));
  } else if (activePage === "overview") content.append(renderOverview());
  else if (activePage === "tasks") content.append(renderTasks());
  else content.append(renderDiagnostics());
  shell.append(sidebar, content);
  root.append(shell);
}

void loadData();
