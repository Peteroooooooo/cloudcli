/**
 * The label shown under a reply for the model the provider reported, or
 * `null` when there is nothing to show. Used by chat's MessageModelLabel.
 *
 * The id is shown as reported, not folded into a family name: behind a
 * gateway, ids such as `claude-opus-5-5` and `claude-opus-4-8` are different
 * routes, and "Opus" would hide which one answered.
 */
export const formatAnsweringModelLabel = (model: string | undefined): string | null => {
  const reportedModel = model?.trim();
  return reportedModel ? reportedModel : null;
};
