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
    const request = Object.freeze({ ...input });
    // Blank versionId makes the Go command fall back to a mutable ref; blank
    // workspace can similarly select ambient scope. Refuse before spawning.
    const required = [request.workspaceId, request.projectId, request.resourceId,
      request.slug, request.sourceKey, request.entryPath, request.name, request.versionId];
    if (required.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('missing publish identity');
    }
    const stdout = await run([
      'share', 'publish', request.resourceId,
      '--project-id', request.projectId,
      '--slug', request.slug,
      '--source-key', request.sourceKey,
      '--entry-path', request.entryPath,
      '--name', request.name,
      '--version-id', request.versionId,
      '--json',
    ], { ...velaWorkspaceCommandOptions(request.workspaceId), timeoutMs: 30_000 });
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid receipt');
    const record = value as Record<string, unknown>;
    const snapshot = record.snapshot;
    if (record.slug !== request.slug || record.entryPath !== request.entryPath
      || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1
      || typeof record.publishedAt !== 'number' || !Number.isSafeInteger(record.publishedAt) || record.publishedAt < 0
      || !snapshot || typeof snapshot !== 'object' || !('versionId' in snapshot)
      || snapshot.versionId !== request.versionId) throw new Error('mismatched receipt');
    return { slug: request.slug, version: record.version, publishedAt: record.publishedAt, entryPath: request.entryPath };
  } catch {
    // Child diagnostics can include upstream bodies. No fallback to snapshots
    // or implicit retry: the remote pointer may already have advanced.
    throw new Error('PUBLIC_SHARE_PUBLISH_FAILED');
  }
}
