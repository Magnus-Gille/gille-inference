import { createHash } from "node:crypto";

interface ArchivedReleaseInspection {
  schemaVersion: number;
  model: { id: string; revision: string };
  architecture: { architectures: string[] };
  speculation: { nativeMtp: boolean };
}

export interface RuntimeCompatibilityInput {
  release: ArchivedReleaseInspection;
  requestedRuntimeCommit: string;
  checkoutRuntimeCommit: string;
  checkoutSourceClean: boolean;
  sources: Record<string, string>;
}

export interface RuntimeCompatibilityCheck {
  description: string;
  passed: boolean;
}

export interface RuntimeCompatibilityEvidence {
  path: string;
  sha256: string | null;
  checks: RuntimeCompatibilityCheck[];
  passed: boolean;
}

export interface ModelRuntimeCompatibilityReport {
  schemaVersion: 1;
  model: string;
  modelRevision: string;
  requestedRuntimeCommit: string;
  runtimeCommit: string;
  checkoutSourceClean: boolean;
  selectedArchitecture: string | null;
  nativeMtpRequired: boolean;
  supported: boolean;
  reasons: string[];
  evidence: RuntimeCompatibilityEvidence[];
}

interface SourceRequirement {
  path: string;
  tokenGroups: string[][];
}

interface ArchitectureSupport {
  requirements: SourceRequirement[];
  mtpRequirements: SourceRequirement[];
}

const COMMIT_RE = /^[a-f0-9]{40}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One llama.cpp-backed model family. Adding a new official architecture (for example a future
 * Qwen generation) is one entry in `FAMILIES` once the pinned llama.cpp checkout supports it: name
 * the HF architecture classes, the GGUF/runtime arch tokens, the converter class/file, and the
 * runtime model class/file. The source-token checks below then prove support fail-closed.
 */
export interface ArchitectureFamily {
  /** Official Hugging Face `architectures` values served by this family. */
  architectures: readonly string[];
  /** `MODEL_ARCH.<ggufArch>` in gguf-py and `LLM_ARCH_<ggufArch>` in llama.cpp. */
  ggufArch: string;
  /** Lowercase arch name used by gguf-py, llama-arch.cpp, and speculative decoding. */
  runtimeName: string;
  /** Converter class in `converterFile`. */
  converterClass: string;
  /** Converter module path relative to the llama.cpp checkout. */
  converterFile: string;
  /** Runtime model class, e.g. `llama_model_qwen35`. */
  runtimeClass: string;
  /** Runtime model source path relative to the llama.cpp checkout. */
  modelFile: string;
}

function requirements(architecture: string, family: ArchitectureFamily): ArchitectureSupport {
  const { ggufArch, runtimeName, converterClass, converterFile, runtimeClass, modelFile } = family;
  const converterModule = converterFile.replace(/^conversion\//, "").replace(/\.py$/, "");
  return {
    requirements: [
      {
        path: "conversion/__init__.py",
        tokenGroups: [[`"${architecture}"`, `"${converterModule}"`]],
      },
      {
        path: converterFile,
        tokenGroups: [
          [architecture],
          [`class ${converterClass}`],
          [`MODEL_ARCH.${ggufArch}`],
        ],
      },
      {
        path: "gguf-py/gguf/constants.py",
        tokenGroups: [[ggufArch, `"${runtimeName}"`]],
      },
      {
        path: "src/llama-arch.cpp",
        tokenGroups: [[`LLM_ARCH_${ggufArch}`, `"${runtimeName}"`]],
      },
      {
        path: "src/llama-model.cpp",
        tokenGroups: [[`case LLM_ARCH_${ggufArch}`, `new ${runtimeClass}`]],
      },
      {
        path: modelFile,
        tokenGroups: [
          [`${runtimeClass}::load_arch_hparams`],
          [`${runtimeClass}::build_arch_graph`],
        ],
      },
    ],
    mtpRequirements: [
      {
        path: modelFile,
        tokenGroups: [[`${runtimeClass}::graph_mtp::graph_mtp`, "LLM_GRAPH_TYPE_DECODER_MTP"]],
      },
      {
        path: "common/speculative.cpp",
        tokenGroups: [[runtimeName, "MTP", "common_speculative_impl_draft_mtp"]],
      },
    ],
  };
}

export const FAMILIES: readonly ArchitectureFamily[] = [
  {
    architectures: ["Qwen3_5ForConditionalGeneration", "Qwen3_5ForCausalLM"],
    ggufArch: "QWEN35",
    runtimeName: "qwen35",
    converterClass: "Qwen3_5TextModel",
    converterFile: "conversion/qwen.py",
    runtimeClass: "llama_model_qwen35",
    modelFile: "src/models/qwen35.cpp",
  },
  {
    architectures: ["Qwen3_5MoeForConditionalGeneration", "Qwen3_5MoeForCausalLM"],
    ggufArch: "QWEN35MOE",
    runtimeName: "qwen35moe",
    converterClass: "Qwen3_5MoeTextModel",
    converterFile: "conversion/qwen.py",
    runtimeClass: "llama_model_qwen35moe",
    modelFile: "src/models/qwen35moe.cpp",
  },
  // Qwen 4: add its family here on release day from the official config.json `architectures`
  // and the pinned llama.cpp source. Do not guess names before the release is public.
];

export function buildSupport(families: readonly ArchitectureFamily[]): Map<string, ArchitectureSupport> {
  const support = new Map<string, ArchitectureSupport>();
  for (const family of families) {
    for (const architecture of family.architectures) {
      if (support.has(architecture)) throw new Error(`duplicate architecture family: ${architecture}`);
      support.set(architecture, requirements(architecture, family));
    }
  }
  return support;
}

const SUPPORT = buildSupport(FAMILIES);

export function runtimeCompatibilitySourcePaths(): string[] {
  const paths = new Set<string>();
  for (const support of SUPPORT.values()) {
    for (const requirement of [...support.requirements, ...support.mtpRequirements]) {
      paths.add(requirement.path);
    }
  }
  return [...paths].sort();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function inspectRequirement(
  requirement: SourceRequirement,
  sources: Record<string, string>
): RuntimeCompatibilityEvidence {
  const source = sources[requirement.path];
  if (source === undefined) {
    return {
      path: requirement.path,
      sha256: null,
      checks: [{ description: "required source file is present", passed: false }],
      passed: false,
    };
  }
  const checks = requirement.tokenGroups.map((tokens) => ({
    description: `contains ${tokens.join(" + ")}`,
    passed: tokens.every((token) => source.includes(token)),
  }));
  return {
    path: requirement.path,
    sha256: sha256(source),
    checks,
    passed: checks.every((check) => check.passed),
  };
}

function mergeEvidence(evidence: RuntimeCompatibilityEvidence[]): RuntimeCompatibilityEvidence[] {
  const merged = new Map<string, RuntimeCompatibilityEvidence>();
  for (const item of evidence) {
    const prior = merged.get(item.path);
    if (prior === undefined) {
      merged.set(item.path, item);
    } else {
      prior.checks.push(...item.checks);
      prior.passed = prior.passed && item.passed;
    }
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function inspectModelRuntimeCompatibility(
  input: RuntimeCompatibilityInput
): ModelRuntimeCompatibilityReport {
  if (input.release.schemaVersion !== 1) throw new Error("unsupported release inspection schema");
  if (!MODEL_ID_RE.test(input.release.model.id)) throw new Error("release model id is malformed");
  if (!COMMIT_RE.test(input.release.model.revision)) throw new Error("release revision is not immutable");
  if (!COMMIT_RE.test(input.requestedRuntimeCommit)) {
    throw new Error("requested runtime commit must be an immutable lowercase 40-character revision");
  }
  if (!COMMIT_RE.test(input.checkoutRuntimeCommit)) {
    throw new Error("checkout runtime commit must be an immutable lowercase 40-character revision");
  }
  if (!Array.isArray(input.release.architecture.architectures)) {
    throw new Error("release architecture list is malformed");
  }

  const reasons: string[] = [];
  if (input.checkoutRuntimeCommit !== input.requestedRuntimeCommit) {
    reasons.push(
      `runtime commit mismatch: requested ${input.requestedRuntimeCommit}, checkout ${input.checkoutRuntimeCommit}`
    );
  }
  if (!input.checkoutSourceClean) {
    reasons.push("runtime checkout has tracked modifications in compatibility-critical sources");
  }

  const architectureNames = [...new Set(input.release.architecture.architectures)];
  const supportedNames = architectureNames.filter((architecture) => SUPPORT.has(architecture));
  let selectedArchitecture: string | null = null;
  if (architectureNames.length !== 1 || supportedNames.length !== 1) {
    if (supportedNames.length === 0) {
      reasons.push(
        `unsupported official architecture: ${architectureNames.length === 0 ? "none" : architectureNames.join(", ")}`
      );
    } else {
      reasons.push("release must name exactly one supported architecture");
    }
  } else {
    selectedArchitecture = supportedNames[0]!;
  }

  let evidence: RuntimeCompatibilityEvidence[] = [];
  if (selectedArchitecture !== null) {
    const support = SUPPORT.get(selectedArchitecture)!;
    const required = input.release.speculation.nativeMtp
      ? [...support.requirements, ...support.mtpRequirements]
      : support.requirements;
    evidence = mergeEvidence(required.map((requirement) => inspectRequirement(requirement, input.sources)));
    for (const item of evidence) {
      for (const check of item.checks) {
        if (!check.passed) reasons.push(`${item.path}: ${check.description} is not proven`);
      }
    }
  }

  return {
    schemaVersion: 1,
    model: input.release.model.id,
    modelRevision: input.release.model.revision,
    requestedRuntimeCommit: input.requestedRuntimeCommit,
    runtimeCommit: input.checkoutRuntimeCommit,
    checkoutSourceClean: input.checkoutSourceClean,
    selectedArchitecture,
    nativeMtpRequired: input.release.speculation.nativeMtp,
    supported: reasons.length === 0 && selectedArchitecture !== null,
    reasons,
    evidence,
  };
}

export function renderModelRuntimeCompatibilityMarkdown(
  report: ModelRuntimeCompatibilityReport
): string {
  const lines = [
    "# Model runtime compatibility report",
    "",
    `**Runtime compatibility: ${report.supported ? "PASS" : "FAIL"}**`,
    "",
    `- Model: \`${report.model}\``,
    `- Model revision: \`${report.modelRevision}\``,
    `- Requested llama.cpp revision: \`${report.requestedRuntimeCommit}\``,
    `- Checkout revision: \`${report.runtimeCommit}\``,
    `- Compatibility-critical checkout sources clean: ${report.checkoutSourceClean ? "yes" : "no"}`,
    `- Official architecture: ${report.selectedArchitecture === null ? "unsupported/ambiguous" : `\`${report.selectedArchitecture}\``}`,
    `- Native MTP required: ${report.nativeMtpRequired ? "yes" : "no"}`,
    "",
    "## Decision reasons",
    "",
    ...(report.reasons.length === 0 ? ["- None; every required proof passed."] : report.reasons.map((reason) => `- ${reason}`)),
    "",
    "## Source SHA-256 evidence",
    "",
    "| Source | SHA-256 | Checks | Result |",
    "|---|---|---|---|",
    ...report.evidence.map(
      (item) =>
        `| \`${item.path}\` | \`${item.sha256 ?? "missing"}\` | ${item.checks.map((check) => `${check.passed ? "PASS" : "FAIL"}: ${check.description}`).join("<br>")} | ${item.passed ? "PASS" : "FAIL"} |`
    ),
    "",
    "A PASS proves only source-level converter/runtime wiring at the named revisions. It does not prove a successful build, reference parity, backend correctness, performance, or deployment readiness.",
    "",
  ];
  return lines.join("\n");
}
