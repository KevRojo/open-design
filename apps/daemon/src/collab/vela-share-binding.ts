import { runVelaCommand, velaWorkspaceCommandOptions } from '../integrations/vela-command.js';

export interface VelaShareBindingInput {
  workspaceId: string;
  projectId: string;
  resourceId: string;
  slug: string;
  version: number;
  versionId: string;
}

/** Complete only the captured publication's binding. The Go command uses a
 * dedicated guarded endpoint; never fall back to registration or publication.
 * Callers can supply a runner pinned to the original verified session.
 */
export async function bindVelaShareVersion(input: VelaShareBindingInput, run: typeof runVelaCommand = runVelaCommand): Promise<void> {
  try {
    const request = Object.freeze({ ...input });
    if ([request.workspaceId, request.projectId, request.resourceId, request.slug, request.versionId]
      .some(value => typeof value !== 'string' || !value.trim())
      || !Number.isSafeInteger(request.version) || request.version < 1) throw new Error('invalid binding identity');
    const stdout = await run(['share', 'bind', request.slug, '--project-id', request.projectId,
      '--resource-id', request.resourceId, '--version', String(request.version), '--version-id', request.versionId, '--json'],
    { ...velaWorkspaceCommandOptions(request.workspaceId), timeoutMs: 30_000 });
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid binding receipt');
    const record = value as Record<string, unknown>;
    if (record.status !== 'active' || record.projectId !== request.projectId || record.slug !== request.slug
      || record.verifiedVersion !== request.version || record.verifiedVersionId !== request.versionId) throw new Error('unverified binding');
  } catch {
    throw new Error('PUBLIC_SHARE_BINDING_FAILED');
  }
}
