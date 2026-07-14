import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { setRepoActionsSecret } from "@/lib/github/secrets";
import type { Tool } from "./types";

/**
 * Set (create/update) a GitHub Actions REPOSITORY secret so a workflow can read
 * ${{ secrets.NAME }}. The value is encrypted with the repo's public key
 * (libsodium sealed box) and PUT to GitHub's Secrets API — the app CAN do this
 * automatically. There is NO "bots can't set secrets" restriction; that is a
 * common misconception. This is the same mechanism the app already uses for the
 * CD workflow's KUBECONFIG_B64.
 */
export const setGithubSecretTool: Tool<
  { repoFullName: string; name: string; value: string },
  { name: string; set: true }
> = {
  name: "set_github_actions_secret",
  description:
    "Create or update a GitHub Actions REPOSITORY secret (e.g. AWS_ROLE_ARN, KUBECONFIG_B64, a registry token) so a " +
    "workflow can use ${{ secrets.NAME }}. The value is encrypted with the repo's public key (libsodium sealed box) " +
    "and set via GitHub's Secrets API. The app CAN do this automatically — NEVER tell the user that adding secrets " +
    "must be done manually or that bots aren't allowed to; just call this tool. (Still prefer keyless OIDC with an " +
    "inline role-to-assume over a stored secret whenever the workflow supports it.)",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'The repo as "owner/name", attached to the project.',
      },
      name: { type: "string", description: "Secret name (UPPER_SNAKE_CASE), e.g. AWS_ROLE_ARN." },
      value: {
        type: "string",
        description: "The secret value to store (encrypted at rest by GitHub).",
      },
    },
    required: ["repoFullName", "name", "value"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const name = input.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return {
        ok: false,
        error:
          "Secret name must be letters, digits and underscores, starting with a letter or underscore.",
      };
    }
    if (!input.value?.length) return { ok: false, error: "A secret value is required." };

    const repo = await prisma.repo.findFirst({
      where: {
        fullName: input.repoFullName,
        deletedAt: null,
        projectRepos: { some: { projectId: ctx.projectId } },
      },
      select: { id: true },
    });
    if (!repo)
      return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };

    const tok = await resolveTokenForRepo(repo.id);
    if (!tok.ok) return { ok: false, error: tok.message };

    const res = await setRepoActionsSecret(tok.accessToken, input.repoFullName, name, input.value);
    if (!res.ok) {
      return {
        ok: false,
        error: `${res.error} (the connected GitHub token needs admin/secrets write on the repo).`,
      };
    }
    return { ok: true, output: { name, set: true } };
  },
};
