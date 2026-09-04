export type PromptCategory = {
  name: string;
  weight: number;
  tags?: string[];
};

export type PromptTemplate = {
  id: string;
  text: string;
  category?: string | null;
  tags?: string[] | null;
  weight?: number | null;
};

export type BuiltPrompt = {
  text: string;
  templateId: string;
  category: string | null;
  tags: string[];
};

// ---------------------------------------------------------------------------
// weightedRandom — selects an index from a weight array
// ---------------------------------------------------------------------------

function weightedRandom(weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return Math.floor(Math.random() * weights.length);
  let rand = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    rand -= weights[i];
    if (rand < 0) return i;
  }
  return weights.length - 1;
}

// ---------------------------------------------------------------------------
// selectTemplate — mirrors Zone promptEngine weighted template selection
// ---------------------------------------------------------------------------

export function selectTemplate(
  templates: PromptTemplate[],
  categories: PromptCategory[] = [],
): PromptTemplate | null {
  if (!templates.length) return null;

  let filtered = templates;

  if (categories.length) {
    const catNames = categories.map((c) => c.name.toLowerCase());
    const catFiltered = templates.filter(
      (t) => t.category && catNames.includes(t.category.toLowerCase()),
    );
    if (catFiltered.length) filtered = catFiltered;
  }

  const weights = filtered.map((t) => {
    const base = Math.max(1, t.weight ?? 1);
    const catWeight =
      categories.find((c) => c.name.toLowerCase() === (t.category || "").toLowerCase())?.weight ??
      1;
    return base * catWeight;
  });

  const idx = weightedRandom(weights);
  return filtered[idx] ?? null;
}

// ---------------------------------------------------------------------------
// interpolatePrompt — replace {{variable}} tokens with provided values
// ---------------------------------------------------------------------------

export function interpolatePrompt(
  template: string,
  variables: Record<string, string> = {},
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? "");
}

// ---------------------------------------------------------------------------
// buildPrompt — full weighted prompt generation pipeline (from Zone)
// ---------------------------------------------------------------------------

export function buildPrompt(
  templates: PromptTemplate[],
  options: {
    categories?: PromptCategory[];
    variables?: Record<string, string>;
    tagFilter?: string[];
  } = {},
): BuiltPrompt | null {
  let pool = templates;

  if (options.tagFilter?.length) {
    const tagSet = new Set(options.tagFilter.map((t) => t.toLowerCase()));
    const tagFiltered = templates.filter((tpl) =>
      tpl.tags?.some((tag) => tagSet.has(tag.toLowerCase())),
    );
    if (tagFiltered.length) pool = tagFiltered;
  }

  const selected = selectTemplate(pool, options.categories ?? []);
  if (!selected) return null;

  const text = interpolatePrompt(selected.text, options.variables ?? {});

  return {
    text,
    templateId: selected.id,
    category: selected.category ?? null,
    tags: selected.tags ?? [],
  };
}
