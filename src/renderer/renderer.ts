async function refresh(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status");
  const tasks = document.querySelector<HTMLUListElement>("#tasks");
  if (!status || !tasks) return;
  const statusResult = await window.orchestrator.getStatus();
  status.textContent = statusResult.ok
    ? `Database: ${statusResult.value.database}`
    : `Error: ${statusResult.error.message}`;
  const taskResult = await window.orchestrator.listTasks();
  if (!taskResult.ok) {
    tasks.replaceChildren();
    const error = document.createElement("li");
    error.textContent = taskResult.error.message;
    tasks.append(error);
    return;
  }
  tasks.replaceChildren();
  if (taskResult.value.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No tasks yet.";
    tasks.append(empty);
    return;
  }
  for (const task of taskResult.value) {
    const item = document.createElement("li");
    item.textContent = `${task.title} [${task.status}]`;
    tasks.append(item);
  }
}

document.querySelector<HTMLFormElement>("#task-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  const result = await window.orchestrator.createTask({
    title: String(data.get("title") ?? ""),
    description: String(data.get("description") ?? ""),
    acceptanceCriteria: [String(data.get("criterion") ?? "")],
    riskTier: 1
  });
  const error = document.querySelector<HTMLParagraphElement>("#task-error");
  if (error) error.textContent = result.ok ? "" : result.error.message;
  if (result.ok) {
    form.reset();
    await refresh();
  }
});

void refresh();
