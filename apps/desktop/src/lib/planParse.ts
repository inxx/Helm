// Parse a planner reply into a tasks[] list. The planner is asked to emit JSON; this
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

// The orchestrator clarifies requirements before the planner; it emits a JSON object describing
// whether requirements are ready, the organized requirement so far, open questions, and assumptions.
// Extracted leniently (same candidates as parsePlanTasks) so a little surrounding prose is tolerated.
export interface OrchestratorReply {
  ready: boolean;
  requirement: string;
  questions: string[];
  assumptions: string[];
}

export function parseOrchestratorReply(text: string): OrchestratorReply | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));

  for (const raw of candidates) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || !("ready" in parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      ready: obj.ready === true,
      requirement: typeof obj.requirement === "string" ? obj.requirement : "",
      questions: strings(obj.questions),
      assumptions: strings(obj.assumptions),
    };
  }
  return null;
}

// Drop plan tasks whose title already exists (the planner re-runs statelessly on each follow-up
// and re-emits overlapping tasks) and de-duplicate within the batch. Exact match on a normalized
// title only — fuzzy matching would swallow legitimately distinct tasks.
export function dedupePlanTasks(tasks: PlanTask[], existingTitles: Iterable<string>): PlanTask[] {
  const seen = new Set<string>();
  for (const title of existingTitles) seen.add(normalizeTaskTitle(title));
  const fresh: PlanTask[] = [];
  for (const task of tasks) {
    const key = normalizeTaskTitle(task.title);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(task);
  }
  return fresh;
}

function normalizeTaskTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
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
