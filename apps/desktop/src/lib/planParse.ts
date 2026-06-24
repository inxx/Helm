// Parse ACP's plan reply into a tasks[] list. ACP is asked to emit a tasks[] JSON; this
// extracts it leniently so a little surrounding prose doesn't break materialization. We try
// candidates in order: a fenced ```json block, the whole text, then the outermost { } or [ ].

export interface PlanTask {
  title: string;
  description?: string;
  role?: string;
}

export function parsePlanTasks(text: string): PlanTask[] | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));

  for (const raw of candidates) {
    const tasks = tryParse(raw);
    if (tasks) return tasks;
  }
  return null;
}

// Strip the tasks[] JSON from an assistant reply so the chat shows only prose. The block is
// materialized separately from the raw turn text, so removing it from the display is safe.
// ponytail: only handles ```json fences (what HERMES_TASK_RULE emits); a bare unfenced object
// would still show — switch to parse-and-slice if the rule ever drops the fence.
export function stripPlanJson(text: string): string {
  return text
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, (full, body) => (parsePlanTasks(body) ? "" : full))
    .replace(/```json\b[\s\S]*$/i, "") // mid-stream: an opened fence not yet closed
    .trim();
}

function tryParse(raw: string): PlanTask[] | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(list)) return null;
  const tasks = list
    .filter(
      (item): item is PlanTask =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PlanTask).title === "string" &&
        (item as PlanTask).title.trim().length > 0,
    )
    .map((item) => ({
      title: item.title.trim(),
      description: typeof item.description === "string" ? item.description : undefined,
      role: typeof item.role === "string" ? item.role : undefined,
    }));
  return tasks.length ? tasks : null;
}
