import {
  MANIFEST_KINDS,
  CURATED_KIND_NAMES,
  baseFields,
  FALLBACK_API_VERSIONS,
} from "@/lib/devops/manifest-templates";
import type { Tool } from "./types";

type Output = {
  apiVersions: string[];
  kinds: Array<{
    kind: string;
    apiVersion: string;
    namespaced: boolean;
    fields: Array<{ name: string; label: string; type: string; required: boolean; options?: string[]; default?: string }>;
  }>;
};

/**
 * Catalog for the manifest wizard: the supported apiVersions, the kinds we can
 * generate, and the fields each kind needs. The agent uses this to ask the user
 * the right questions (one at a time), then calls generate_k8s_manifest.
 */
export const listK8sManifestKindsTool: Tool<Record<string, never>, Output> = {
  name: "list_k8s_manifest_kinds",
  description:
    "List the Kubernetes resource kinds the manifest builder can generate, their apiVersions, and " +
    "the fields each kind needs. Call this FIRST when the user wants to create a manifest/k8s file, " +
    "so you know which apiVersion/kind to offer and which fields to ask for.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const kinds = CURATED_KIND_NAMES.map((kind) => {
      const k = MANIFEST_KINDS[kind];
      const fields = [...baseFields(k.namespaced), ...k.fields].map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: !!f.required,
        ...(f.options ? { options: f.options } : {}),
        ...(f.default !== undefined ? { default: f.default } : {}),
      }));
      return { kind, apiVersion: k.apiVersion, namespaced: k.namespaced, fields };
    });
    return { ok: true, output: { apiVersions: FALLBACK_API_VERSIONS, kinds } };
  },
};
