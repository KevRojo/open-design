import { runVelaCommand, velaWorkspaceCommandOptions } from '../integrations/vela-command.js';

export interface VelaSharePublishInput {
  workspaceId: string;
  projectId: string;
  resourceId: string;
  slug: string;
  sourceKey: string;
  entryPath: string;
  name: string;
  versionId: string;
}

/** Go share publish advances the alias and registers the project binding.
 * Accept only a receipt for this exact alias, entry and immutable upload.
 * This returns content metadata, not proof of lifecycle status or reachability.
 */
export async function publishVelaShareVersion(
  input: VelaSharePublishInput,
  run: typeof runVelaCommand = runVelaCommand,
): Promise<{ slug: string; version: number; publishedAt: number; entryPath: string }> {
  try {
    const stdout = await run([
      'share', 'publish', input.resourceId,
      '--project-id', input.projectId,
      '--slug', input.slug,
      '--source-key', input.sourceKey,
      '--entry-path', input.entryPath,
      '--name', input.name,
      '--version-id', input.versionId,
      '--json',
    ], { ...velaWorkspaceCommandOptions(input.workspaceId), timeoutMs: 30_000 });
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
    const record = value as Record<string, unknown>;
    const snapshot = record.snapshot;
    if (record.slug !== input.slug || record.entryPath !== input.entryPath
      || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1
      || typeof record.publishedAt !== 'number' || !Number.isSafeInteger(record.publishedAt) || record.publishedAt < 0
      || !snapshot || typeof snapshot !== 'object' || !('versionId' in snapshot)
      || snapshot.versionId !== input.versionId) throw new Error('mismatched receipt');
    return { slug: input.slug, version: record.version, publishedAt: record.publishedAt, entryPath: input.entryPath };
  } catch {
    // Child diagnostics can include upstream bodies. No fallback to snapshots
    // or implicit retry: the remote pointer may already have advanced.
    throw new Error('PUBLIC_SHARE_PUBLISH_FAILED');
  }
}
