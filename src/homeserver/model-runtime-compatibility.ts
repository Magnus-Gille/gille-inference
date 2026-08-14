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

function requirements(
  architecture: string,
  ggufArch: "QWEN35" | "QWEN35MOE",
  runtimeArch: "QWEN35" | "QWEN35MOE",
  runtimeName: "qwen35" | "qwen35moe",
  converterClass: "Qwen3_5TextModel" | "Qwen3_5MoeTextModel",
  runtimeClass: "llama_model_qwen35" | "llama_model_qwen35moe",
  modelFile: "src/models/qwen35.cpp" | "src/models/qwen35moe.cpp"
): ArchitectureSupport {
  return {
    requirements: [
      {
        path: "conversion/__init__.py",
        tokenGroups: [[`"${architecture}"`, `"qwen"`]],
      },
      {
        path: "conversion/qwen.py",
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
        tokenGroups: [[`LLM_ARCH_${runtimeArch}`, `"${runtimeName}"`]],
      },
      {
        path: "src/llama-model.cpp",
        tokenGroups: [[`case LLM_ARCH_${runtimeArch}`, `new ${runtimeClass}`]],
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

const SUPPORT = new Map<string, ArchitectureSupport>([
  [
    "Qwen3_5ForConditionalGeneration",
    requirements(
      "Qwen3_5ForConditionalGeneration",
      "QWEN35",
      "QWEN35",
      "qwen35",
      "Qwen3_5TextModel",
      "llama_model_qwen35",
      "src/models/qwen35.cpp"
    ),
  ],
  [
    "Qwen3_5ForCausalLM",
    requirements(
      "Qwen3_5ForCausalLM",
      "QWEN35",
      "QWEN35",
      "qwen35",
      "Qwen3_5TextModel",
      "llama_model_qwen35",
      "src/models/qwen35.cpp"
    ),
  ],
  [
    "Qwen3_5MoeForConditionalGeneration",
    requirements(
      "Qwen3_5MoeForConditionalGeneration",
      "QWEN35MOE",
      "QWEN35MOE",
      "qwen35moe",
      "Qwen3_5MoeTextModel",
      "llama_model_qwen35moe",
      "src/models/qwen35moe.cpp"
    ),
  ],
  [
    "Qwen3_5MoeForCausalLM",
    requirements(
      "Qwen3_5MoeForCausalLM",
      "QWEN35MOE",
      "QWEN35MOE",
      "qwen35moe",
      "Qwen3_5MoeTextModel",
      "llama_model_qwen35moe",
      "src/models/qwen35moe.cpp"
    ),
  ],
]);

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
