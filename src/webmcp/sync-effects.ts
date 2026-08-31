import type { QueryClient } from "@tanstack/react-query";
import type { EffectRef } from "../shared/contracts/common";
import type { Workspace } from "../api/models";
export type UiSync = "synchronized" | "refresh_required";
export async function syncEffects(effects: readonly EffectRef[], query: QueryClient, fetchCase: (id: string) => Promise<Workspace>): Promise<UiSync> {
  const targets = new Map<string, number>();
  for (const effect of effects) if (effect.entityType === "return_case" || effect.entityType === "case") targets.set(effect.entityId, Math.max(targets.get(effect.entityId) ?? 0, effect.entityVersion));
  try {
    for (const [id, version] of targets) {
      let synchronized = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const facts = await fetchCase(id);
        if (facts.version >= version) {
          query.setQueryData<Workspace>(["case", id], current => current && current.version > facts.version ? current : facts);
          synchronized = true; break;
        }
      }
      if (!synchronized) return "refresh_required";
    }
    await query.invalidateQueries({ predicate: q => q.queryKey[0] !== "case" });
    return "synchronized";
  } catch { return "refresh_required"; }
}
