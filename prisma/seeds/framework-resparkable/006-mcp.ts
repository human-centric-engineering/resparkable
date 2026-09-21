import type { SeedUnit } from '@/prisma/runner';
import {
  RESPARKABLE_MCP_PROMPTS,
  RESPARKABLE_MCP_RESOURCES,
  RESPARKABLE_MCP_TOOLS,
} from '@/lib/framework/resparkable/mcp/exposure';

/**
 * Expose the brain over MCP: eight tools, three prompts and two resources.
 *
 * **This seed is nearly the whole of "usable from Claude Code".** The tools
 * needed no Resparkable code at all: `protocol-handler.ts` sets
 * `CapabilityContext.userId` from the key's creator, and every Resparkable
 * capability already refuses to run without one, so per-user scoping over MCP is
 * the guard the tier already had. Rows were all that was missing.
 *
 * The two resources are the exception, and only because core's resource path
 * carries no guards and hands a handler no scope carrier. `mcp/resources.ts`
 * does that work; these rows are still what makes it reachable.
 *
 * **Rows are created enabled, against core's default-deny.** `McpExposedTool`
 * and `McpExposedResource` both default `isEnabled: false` so that nothing an
 * admin has not thought about is reachable. That default is protecting against exposure by accident, and these
 * rows are not accidental — they are a curated list with a written reason each
 * (`lib/framework/resparkable/mcp/exposure.ts`), and there are still two operator
 * gates in front of them: `McpServerConfig.isEnabled` is false until someone
 * turns the server on, and nothing reaches the server without a minted key.
 * Seeding them off would mean eight admin clicks between installing Resparkable and
 * the feature working, with nothing decided in between.
 *
 * **The update branch leaves `isEnabled` alone.** Same rule as
 * `004-agent-capabilities`: an operator who turned `resparkable_ideate` off to
 * control spend keeps it off across deploys. What the update branch *does*
 * rewrite is the annotations and title, which are code artefacts — a stale
 * `readOnlyHint` tells a client a write is safe to retry.
 *
 * A capability with no row here is not reachable over MCP at all, which is the
 * correct default for everything that creates structure.
 */
const unit: SeedUnit = {
  name: 'framework-resparkable/006-mcp',
  /**
   * The manifest is this seed's real content — same reason `001` hashes the
   * catalogue. Without it, adding a ninth tool leaves the seed "unchanged,
   * skipping" and the tool simply never appears in `tools/list`, with nothing
   * failing anywhere to say so.
   */
  hashInputs: ['../../../lib/framework/resparkable/mcp/exposure.ts'],
  async run({ prisma, logger }) {
    logger.info(`🔌 Exposing ${RESPARKABLE_MCP_TOOLS.length} Resparkable capabilities over MCP...`);

    for (const tool of RESPARKABLE_MCP_TOOLS) {
      const capability = await prisma.aiCapability.findUnique({
        where: { slug: tool.slug },
        select: { id: true },
      });

      // Loud, not silent. `001` runs first and every slug here comes from the
      // same const map it seeds from, so a miss means the capability seed did
      // not run — and a warning that scrolls past would leave an operator with
      // a tool list that is quietly short.
      if (!capability) {
        throw new Error(
          `framework-resparkable/006-mcp: no AiCapability row for "${tool.slug}". ` +
            'Run framework-resparkable/001-capabilities first.'
        );
      }

      const annotations = {
        customTitle: tool.title,
        readOnlyHint: tool.readOnlyHint,
        destructiveHint: tool.destructiveHint,
        openWorldHint: tool.openWorldHint,
        // Deliberately null: this column overrides `AiCapability.isIdempotent`,
        // which is already right for every one of these.
        idempotentHint: null,
      };

      await prisma.mcpExposedTool.upsert({
        where: { capabilityId: capability.id },
        update: annotations,
        create: {
          capabilityId: capability.id,
          isEnabled: true,
          ...annotations,
        },
      });

      logger.info(`  ✓ ${tool.slug}`);
    }

    logger.info(`🔌 Seeding ${RESPARKABLE_MCP_PROMPTS.length} Resparkable MCP prompts...`);

    for (const prompt of RESPARKABLE_MCP_PROMPTS) {
      await prisma.mcpExposedPrompt.upsert({
        where: { name: prompt.name },
        // Only the human-facing description is refreshed, matching
        // `005-workflows`: a template is editable at
        // `/admin/orchestration/mcp/prompts`, and rewriting it every deploy
        // would silently discard whatever an operator tuned. `name` is not
        // here at all — core makes it immutable post-create, because a rename
        // breaks every client that bookmarked the slash command.
        update: { description: prompt.description },
        create: {
          name: prompt.name,
          description: prompt.description,
          template: prompt.template,
          // No widening cast needed, unlike `001-capabilities`: the argument
          // specs are plain object literals, so Prisma's `InputJsonValue`
          // accepts them structurally.
          argumentsSpec: prompt.argumentsSpec,
          isEnabled: true,
        },
      });

      logger.info(`  ✓ ${prompt.name}`);
    }

    logger.info(`🔌 Seeding ${RESPARKABLE_MCP_RESOURCES.length} Resparkable MCP resources...`);

    for (const resource of RESPARKABLE_MCP_RESOURCES) {
      await prisma.mcpExposedResource.upsert({
        where: { uri: resource.uri },
        // `resourceType` is not in the update branch and `uri` cannot be: the
        // two together are the join to a registered handler, and rewriting
        // either on an existing row would point it somewhere new without the
        // operator asking. Changing a URI in the manifest therefore creates a
        // second row, and the old one has to be removed by hand at
        // `/admin/orchestration/mcp/resources`.
        update: {
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        create: {
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
          resourceType: resource.resourceType,
          isEnabled: true,
        },
      });

      logger.info(`  ✓ ${resource.uri}`);
    }

    logger.info(
      '🔌 MCP exposure seeded. A running server caches these lists for 5 minutes: ' +
        'restart it, or wait, before expecting tools/list or resources/list to change.'
    );
  },
};

export default unit;
