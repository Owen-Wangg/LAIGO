import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Slider,
  IconButton,
  Tooltip,
  Snackbar,
  Alert,
  LinearProgress,
  CircularProgress,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";
import { fetchAuthSession } from "aws-amplify/auth";
import { useWebSocket } from "../../hooks/useWebSocket";
import UserMessage from "../../components/Chat/UserMessage";
import AIResponse from "../../components/Chat/AIResponse";
import ThinkingIndicator from "../../components/Chat/ThinkingIndicator";

// Types
interface Message {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
}

// Case Context Interface
interface CaseContext {
  case_type: string;
  jurisdiction: string;
  case_description: string;
  province: string;
  statute: string;
}

interface AssessmentResult {
  progress: number;
  reasoning: string;
  unlocked: boolean;
}

interface ConfigurationState {
  blockType: string;
  modelId: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  selectedVersionId: string | null;
  sessionId: string; // This is now the testId part
  messages: Message[];
  isLoading: boolean;
  caseContext: CaseContext;
  // Assessment mode state
  assessmentPrompt: string;
  assessmentVersionId: string | null;
  assessmentResult: AssessmentResult | null;
  isAssessing: boolean;
}

interface PromptVersion {
  prompt_version_id: string;
  version_number: number;
  version_name: string;
  prompt_text: string;
  is_active: boolean;
}

interface ModelOption {
  id: string;
  name: string;
  constraints?: {
    maxOutputTokens: number;
    defaultMaxOutputTokens: number;
    temperatureRange: [number, number];
    topPRange: [number, number];
  };
}

const FALLBACK_AVAILABLE_MODELS: ModelOption[] = [
  {
    id: "us.anthropic.claude-sonnet-5",
    name: "Claude Sonnet 5",
    constraints: {
      maxOutputTokens: 128000,
      defaultMaxOutputTokens: 4096,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
  {
    id: "meta.llama3-70b-instruct-v1:0",
    name: "Llama 3 70b Instruct",
    constraints: {
      maxOutputTokens: 8192,
      defaultMaxOutputTokens: 2000,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
];

// Block types for prompt selection
const BLOCK_TYPES = [
  { id: "intake", label: "Intake & Facts" },
  { id: "legal_analysis", label: "Legal Analysis" },
  { id: "contrarian", label: "Contrarian Analysis" },
  { id: "policy", label: "Policy Analysis" },
];

// Only these blocks have assessment prompts
const ASSESSABLE_BLOCK_TYPES = [
  { id: "intake", label: "Intake & Facts" },
  { id: "legal_analysis", label: "Legal Analysis" },
  { id: "contrarian", label: "Contrarian Analysis" },
  { id: "policy", label: "Policy Analysis" },
];

type PlaygroundMode = "reasoning" | "assessment";

const DEFAULT_PROMPT = `You are a helpful AI assistant for law students. Provide clear, educational responses that help the student think through legal problems. Be supportive and guide them through their analysis step by step.`;

const DEFAULT_CASE_CONTEXT: CaseContext = {
  case_type: "Other",
  jurisdiction: "Federal, Provincial",
  case_description:
    "The defendant is an unemployed warehouse worker who is currently receiving approximately $1400 a month in unemployment insurance. His parents have a house and he is currently living there rent-free as they are both in a long-term care facility. The first floor of the house has a front door and also has a garage. There is a side door entrance to the garage, and the garage also has an interior door which connects to a kitchen on the first floor of the house. The kitchen has a back door which leads to an open back yard. One evening the defendant was doing some woodwork in his garage when he heard someone knocking at the front door of the house, and then the person seemed to be trying to open the front door which was locked. This concerned the defendant as there had been a number of break-ins in his area recently. He then heard the person walk to the garage door. That door was not locked, but was difficult to open because the wood door had swelled because of water damage. The defendant saw that the garage door handle was turning, and then the person was attempting to push the door open. The defendant grabbed a bat which was in the garage. The door suddenly popped open, and a person stumbled into the garage. The defendant immediately panicked and hit the leg of the person with the baseball bat. The person fell to the ground. The defendant then noticed that the person was holding his phone and had a suitcase with him. It turned out that the person was a visitor who had booked a short-term rental for a residence beside the defendant’s house, and was accidentally attempting to enter the wrong address. The person developed a bruise on his leg which lasted a couple of days.",
  province: "British Columbia",
  statute: "Criminal Code of Canada",
};

const generateTestId = () => {
  if (typeof globalThis.crypto !== "undefined") {
    if (typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    }

    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Non-random fallback for environments without Web Crypto.
  return `${Date.now().toString(36)}${performance.now().toString(36).replace(".", "")}`.slice(-8);
};

const createDefaultConfig = (
  blockType: string = "intake",
  defaultModelId: string = FALLBACK_AVAILABLE_MODELS[0].id,
): ConfigurationState => ({
  blockType,
  modelId: defaultModelId,
  temperature: 0.5,
  topP: 0.9,
  maxTokens: 2048,
  systemPrompt: DEFAULT_PROMPT,
  selectedVersionId: null,
  sessionId: generateTestId(),
  messages: [],
  isLoading: false,
  caseContext: { ...DEFAULT_CASE_CONTEXT },
  assessmentPrompt: "",
  assessmentVersionId: null,
  assessmentResult: null,
  isAssessing: false,
});

// Model Configuration Section - Top section with model settings
const ModelConfigSection: React.FC<{
  config: ConfigurationState;
  onConfigChange: (updates: Partial<ConfigurationState>) => void;
  availableModels: ModelOption[];
  label?: string;
}> = React.memo(({ config, onConfigChange, availableModels, label }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const selectedModel = availableModels.find((m) => m.id === config.modelId);
  const temperatureMin = selectedModel?.constraints?.temperatureRange?.[0] ?? 0;
  const temperatureMax = selectedModel?.constraints?.temperatureRange?.[1] ?? 1;
  const topPMin = selectedModel?.constraints?.topPRange?.[0] ?? 0;
  const topPMax = selectedModel?.constraints?.topPRange?.[1] ?? 1;
  const maxTokensLimit = selectedModel?.constraints?.maxOutputTokens ?? 8192;

  return (
    <Box
      sx={{
        border: "1px solid var(--border)",
        borderRadius: 2,
        backgroundColor: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          p: 2,
          backgroundColor: "var(--header)",
          borderBottom: isExpanded ? "1px solid var(--border)" : "none",
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
        }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <AddIcon
          fontSize="small"
          sx={{
            transform: isExpanded ? "rotate(45deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            color: "var(--text-secondary)",
          }}
        />
        <Typography
          variant="subtitle2"
          sx={{ fontWeight: "bold", color: "var(--text)", textAlign: "left" }}
        >
          {label ? `${label} - Model Configuration` : "Model Configuration"}
        </Typography>
      </Box>

      {isExpanded && (
        <Box
          sx={{
            p: 2,
            display: "flex",
            gap: 3,
            flexWrap: "wrap",
            alignItems: "flex-end",
          }}
        >
          {/* Model Selection */}
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel sx={{ color: "var(--text-secondary)" }}>
              Model
            </InputLabel>
            <Select
              value={config.modelId}
              label="Model"
              onChange={(e) => {
                const newModelId = e.target.value;
                const selectedModel = availableModels.find(
                  (m) => m.id === newModelId,
                );
                const updates: Partial<ConfigurationState> = { modelId: newModelId };
                if (selectedModel?.constraints) {
                  updates.maxTokens = selectedModel.constraints.defaultMaxOutputTokens;
                }
                onConfigChange(updates);
              }}
              sx={{
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& .MuiOutlinedInput-notchedOutline": {
                  borderColor: "var(--border)",
                },
                "&:hover .MuiOutlinedInput-notchedOutline": {
                  borderColor: "var(--primary)",
                },
              }}
            >
              {availableModels.map((model) => (
                <MenuItem key={model.id} value={model.id}>
                  {model.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Temperature */}
          <Box sx={{ width: 140 }}>
            <Typography
              variant="caption"
              sx={{ color: "var(--text-secondary)", display: "block", mb: 0.5 }}
            >
              Temperature: {config.temperature.toFixed(2)}
            </Typography>
            <Slider
              value={config.temperature}
              onChange={(_, v) => onConfigChange({ temperature: v as number })}
              min={temperatureMin}
              max={temperatureMax}
              step={0.01}
              size="small"
              sx={{ color: "var(--primary)", py: 1 }}
            />
          </Box>

          {/* Top P */}
          <Box sx={{ width: 140 }}>
            <Typography
              variant="caption"
              sx={{ color: "var(--text-secondary)", display: "block", mb: 0.5 }}
            >
              Top P: {config.topP.toFixed(2)}
            </Typography>
            <Slider
              value={config.topP}
              onChange={(_, v) => onConfigChange({ topP: v as number })}
              min={topPMin}
              max={topPMax}
              step={0.01}
              size="small"
              sx={{ color: "var(--primary)", py: 1 }}
            />
          </Box>

          {/* Max Tokens */}
          <TextField
            label={`Max Tokens (Max: ${maxTokensLimit})`}
            type="number"
            size="small"
            inputProps={{
              min: 1,
              max: maxTokensLimit,
            }}
            value={config.maxTokens}
            onChange={(e) => {
              const value = parseInt(e.target.value) || 2048;
              onConfigChange({ maxTokens: Math.min(value, maxTokensLimit) });
            }}
            sx={{
              width: 100,
              "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
              "& .MuiOutlinedInput-root": {
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& fieldset": { borderColor: "var(--border)" },
              },
            }}
          />
        </Box>
      )}
    </Box>
  );
});

// Mock Case Context Section - Collapsible section for case details
const MockCaseContextSection: React.FC<{
  config: ConfigurationState;
  onConfigChange: (updates: Partial<ConfigurationState>) => void;
  label?: string;
}> = React.memo(({ config, onConfigChange, label }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleContextChange = (field: keyof CaseContext, value: string) => {
    onConfigChange({
      caseContext: {
        ...config.caseContext,
        [field]: value,
      },
    });
  };

  const handleReset = () => {
    onConfigChange({
      caseContext: { ...DEFAULT_CASE_CONTEXT },
    });
  };

  return (
    <Box
      sx={{
        border: "1px solid var(--border)",
        borderRadius: 2,
        backgroundColor: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          p: 2,
          backgroundColor: "var(--header)",
          borderBottom: isExpanded ? "1px solid var(--border)" : "none",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
        }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <AddIcon
            fontSize="small"
            sx={{
              transform: isExpanded ? "rotate(45deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
              color: "var(--text-secondary)",
            }}
          />
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: "bold", color: "var(--text)" }}
          >
            {label ? `${label} - Mock Case Context` : "Mock Case Context"}
          </Typography>
        </Box>
        <Button
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            handleReset();
          }}
          sx={{
            color: "var(--primary)",
            textTransform: "none",
            minWidth: 0,
            p: 0.5,
          }}
        >
          Reset Default
        </Button>
      </Box>

      {isExpanded && (
        <Box
          sx={{
            p: 2,
            display: "grid",
            gap: 2,
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          }}
        >
          <TextField
            label="Case Type"
            size="small"
            value={config.caseContext.case_type}
            onChange={(e) => handleContextChange("case_type", e.target.value)}
            fullWidth
            sx={{
              "& .MuiOutlinedInput-root": {
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& fieldset": { borderColor: "var(--border)" },
              },
              "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
            }}
          />
          <TextField
            label="Jurisdiction"
            size="small"
            value={config.caseContext.jurisdiction}
            onChange={(e) =>
              handleContextChange("jurisdiction", e.target.value)
            }
            fullWidth
            sx={{
              "& .MuiOutlinedInput-root": {
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& fieldset": { borderColor: "var(--border)" },
              },
              "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
            }}
          />
          <TextField
            label="Province"
            size="small"
            value={config.caseContext.province}
            onChange={(e) => handleContextChange("province", e.target.value)}
            fullWidth
            sx={{
              "& .MuiOutlinedInput-root": {
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& fieldset": { borderColor: "var(--border)" },
              },
              "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
            }}
          />
          <TextField
            label="Statute"
            size="small"
            value={config.caseContext.statute}
            onChange={(e) => handleContextChange("statute", e.target.value)}
            fullWidth
            sx={{
              "& .MuiOutlinedInput-root": {
                color: "var(--text)",
                backgroundColor: "var(--background)",
                "& fieldset": { borderColor: "var(--border)" },
              },
              "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
            }}
          />
          <Box sx={{ gridColumn: "1 / -1" }}>
            <TextField
              label="Case Description"
              multiline
              rows={2}
              size="small"
              value={config.caseContext.case_description}
              onChange={(e) =>
                handleContextChange("case_description", e.target.value)
              }
              fullWidth
              sx={{
                "& .MuiOutlinedInput-root": {
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  "& fieldset": { borderColor: "var(--border)" },
                },
                "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
});

// System Prompt Section - Middle section for prompt selection and editing
const SystemPromptSection: React.FC<{
  config: ConfigurationState;
  onConfigChange: (updates: Partial<ConfigurationState>) => void;
  promptVersions: PromptVersion[];
  onLoadVersion: (versionId: string) => void;
  onSave: () => void;
  label?: string;
  compareMode?: boolean;
}> = React.memo(
  ({
    config,
    onConfigChange,
    promptVersions,
    onLoadVersion,
    onSave,
    label,
    compareMode,
  }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    return (
      <Box
        sx={{
          border: "1px solid var(--border)",
          borderRadius: 2,
          backgroundColor: "var(--paper)",
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            p: 2,
            backgroundColor: "var(--header)",
            borderBottom: isExpanded ? "1px solid var(--border)" : "none",
            display: "flex",
            flexDirection: compareMode ? "column" : "row",
            justifyContent: "space-between",
            alignItems: compareMode ? "stretch" : "center",
            gap: compareMode ? 1.5 : 2,
            cursor: "pointer",
          }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <Box
            sx={{
              display: "flex",
              justifyContent: compareMode ? "space-between" : "flex-start",
              alignItems: "center",
              width: compareMode ? "100%" : "auto",
              flexShrink: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              <AddIcon
                fontSize="small"
                sx={{
                  transform: isExpanded ? "rotate(45deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                  color: "var(--text-secondary)",
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: "bold",
                  color: "var(--text)",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
              >
                {label ? `${label} - System Prompt` : "System Prompt"}
              </Typography>
            </Box>

            {/* Save Button - Top row in compare mode, part of flex group otherwise */}
            {compareMode && config.selectedVersionId && (
              <Tooltip title="Save Version">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSave();
                  }}
                  sx={{
                    color: "var(--primary)",
                    "&:hover": { backgroundColor: "var(--header-hover)" },
                  }}
                >
                  <SaveIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          <Box
            sx={{
              display: "flex",
              gap: 1,
              alignItems: "center",
              flexWrap: compareMode ? "wrap" : "nowrap",
              justifyContent: compareMode ? "flex-start" : "flex-end",
              flex: compareMode ? "none" : 1,
              overflow: "visible",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Stage Type Selection */}
            <FormControl
              size="small"
              sx={{
                width: compareMode ? "calc(50% - 4px)" : 200,
                minWidth: compareMode ? 0 : 200,
                flexShrink: 0,
              }}
            >
              <InputLabel sx={{ color: "var(--text-secondary)" }}>
                Stage Type
              </InputLabel>
              <Select
                value={config.blockType}
                label="Stage Type"
                onChange={(e) => onConfigChange({ blockType: e.target.value })}
                sx={{
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderColor: "var(--border)",
                  },
                }}
              >
                {BLOCK_TYPES.map((block) => (
                  <MenuItem key={block.id} value={block.id}>
                    {block.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Load Version */}
            <FormControl
              size="small"
              sx={{
                width: compareMode ? "calc(50% - 4px)" : 200,
                minWidth: compareMode ? 0 : 200,
                flexShrink: 0,
              }}
            >
              <InputLabel sx={{ color: "var(--text-secondary)" }}>
                Version
              </InputLabel>
              <Select
                value={config.selectedVersionId || ""}
                label="Version"
                onChange={(e) => {
                  if (e.target.value) {
                    onLoadVersion(e.target.value);
                  }
                }}
                sx={{
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderColor: "var(--border)",
                  },
                }}
              >
                <MenuItem value="" disabled>
                  <em>None</em>
                </MenuItem>
                {promptVersions.map((v) => (
                  <MenuItem
                    key={v.prompt_version_id}
                    value={v.prompt_version_id}
                  >
                    v{v.version_number}{" "}
                    {v.version_name ? `- ${v.version_name}` : ""}{" "}
                    {v.is_active ? "(Active)" : ""}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Save Button - Inline in regular mode */}
            {!compareMode && config.selectedVersionId && (
              <Tooltip title="Save Version">
                <IconButton
                  size="small"
                  onClick={onSave}
                  sx={{
                    color: "var(--primary)",
                    "&:hover": { backgroundColor: "var(--header-hover)" },
                  }}
                >
                  <SaveIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>

        {isExpanded && (
          <Box sx={{ p: 2 }}>
            {/* Prompt Text Area */}
            <TextField
              multiline
              rows={5}
              fullWidth
              size="small"
              value={config.systemPrompt}
              onChange={(e) => onConfigChange({ systemPrompt: e.target.value })}
              placeholder="Enter your system prompt..."
              sx={{
                "& .MuiOutlinedInput-root": {
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  fontSize: "0.9rem",
                  "& fieldset": { borderColor: "var(--border)" },
                  "&:hover fieldset": { borderColor: "var(--primary)" },
                  "& textarea": {
                    resize: "vertical",
                  },
                  "& textarea::-webkit-resizer": {
                    backgroundColor: "var(--background)",
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M10 0 L0 10 M10 4 L4 10 M10 8 L8 10' stroke='%23888' stroke-width='1'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "bottom right",
                  },
                },
              }}
            />
          </Box>
        )}
      </Box>
    );
  },
);

// Assessment Prompt Section - Swapped in for assessment mode
const AssessmentPromptSection: React.FC<{
  config: ConfigurationState;
  onConfigChange: (updates: Partial<ConfigurationState>) => void;
  assessmentVersions: PromptVersion[];
  onLoadVersion: (versionId: string) => void;
  onSave: () => void;
  label?: string;
  compareMode?: boolean;
}> = React.memo(
  ({
    config,
    onConfigChange,
    assessmentVersions,
    onLoadVersion,
    onSave,
    label,
    compareMode,
  }) => {
    const [isExpanded, setIsExpanded] = useState(false);

    return (
      <Box
        sx={{
          border: "1px solid var(--border)",
          borderRadius: 2,
          backgroundColor: "var(--paper)",
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            p: 2,
            backgroundColor: "var(--header)",
            borderBottom: isExpanded ? "1px solid var(--border)" : "none",
            display: "flex",
            flexDirection: compareMode ? "column" : "row",
            justifyContent: "space-between",
            alignItems: compareMode ? "stretch" : "center",
            gap: compareMode ? 1.5 : 2,
            cursor: "pointer",
          }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <Box
            sx={{
              display: "flex",
              justifyContent: compareMode ? "space-between" : "flex-start",
              alignItems: "center",
              width: compareMode ? "100%" : "auto",
              flexShrink: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              <AddIcon
                fontSize="small"
                sx={{
                  transform: isExpanded ? "rotate(45deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                  color: "var(--text-secondary)",
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: "bold",
                  color: "var(--text)",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
              >
                {label ? `${label} - Assessment Prompt` : "Assessment Prompt"}
              </Typography>
            </Box>

            {/* Save Button - Top row in compare mode, part of flex group otherwise */}
            {compareMode && config.assessmentVersionId && (
              <Tooltip title="Save Version">
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSave();
                  }}
                  sx={{
                    color: "var(--primary)",
                    "&:hover": { backgroundColor: "var(--header-hover)" },
                  }}
                >
                  <SaveIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          <Box
            sx={{
              display: "flex",
              gap: 1,
              alignItems: "center",
              flexWrap: compareMode ? "wrap" : "nowrap",
              justifyContent: compareMode ? "flex-start" : "flex-end",
              flex: compareMode ? "none" : 1,
              overflow: "visible",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Stage Type Selection - only assessable stages */}
            <FormControl
              size="small"
              sx={{
                width: compareMode ? "calc(50% - 4px)" : 200,
                minWidth: compareMode ? 0 : 200,
                flexShrink: 0,
              }}
            >
              <InputLabel sx={{ color: "var(--text-secondary)" }}>
                Stage Type
              </InputLabel>
              <Select
                value={config.blockType}
                label="Stage Type"
                onChange={(e) => onConfigChange({ blockType: e.target.value })}
                sx={{
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderColor: "var(--border)",
                  },
                }}
              >
                {ASSESSABLE_BLOCK_TYPES.map((block) => (
                  <MenuItem key={block.id} value={block.id}>
                    {block.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Version Selector */}
            <FormControl
              size="small"
              sx={{
                width: compareMode ? "calc(50% - 4px)" : 200,
                minWidth: compareMode ? 0 : 200,
                flexShrink: 0,
              }}
            >
              <InputLabel sx={{ color: "var(--text-secondary)" }}>
                Version
              </InputLabel>
              <Select
                value={config.assessmentVersionId || ""}
                label="Version"
                onChange={(e) => {
                  if (e.target.value) {
                    onLoadVersion(e.target.value);
                  }
                }}
                sx={{
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderColor: "var(--border)",
                  },
                }}
              >
                <MenuItem value="" disabled>
                  <em>None</em>
                </MenuItem>
                {assessmentVersions.map((v) => (
                  <MenuItem
                    key={v.prompt_version_id}
                    value={v.prompt_version_id}
                  >
                    v{v.version_number}{" "}
                    {v.version_name ? `- ${v.version_name}` : ""}{" "}
                    {v.is_active ? "(Active)" : ""}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Save Button - Inline in regular mode */}
            {!compareMode && config.assessmentVersionId && (
              <Tooltip title="Save Version">
                <IconButton
                  size="small"
                  onClick={onSave}
                  sx={{
                    color: "var(--primary)",
                    "&:hover": { backgroundColor: "var(--header-hover)" },
                  }}
                >
                  <SaveIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>

        {isExpanded && (
          <Box sx={{ p: 2 }}>
            <TextField
              multiline
              rows={5}
              fullWidth
              size="small"
              value={config.assessmentPrompt}
              onChange={(e) =>
                onConfigChange({ assessmentPrompt: e.target.value })
              }
              placeholder="Enter your assessment prompt criteria..."
              sx={{
                "& .MuiOutlinedInput-root": {
                  color: "var(--text)",
                  backgroundColor: "var(--background)",
                  fontSize: "0.9rem",
                  "& fieldset": { borderColor: "var(--border)" },
                  "&:hover fieldset": { borderColor: "var(--primary)" },
                  "& textarea": {
                    resize: "vertical",
                  },
                  "& textarea::-webkit-resizer": {
                    backgroundColor: "var(--background)",
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M10 0 L0 10 M10 4 L4 10 M10 8 L8 10' stroke='%23888' stroke-width='1'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "bottom right",
                  },
                },
              }}
            />
          </Box>
        )}
      </Box>
    );
  },
);

// Assessment Score Panel - Shows live grading results
const AssessmentScorePanel: React.FC<{
  result: AssessmentResult | null;
  isAssessing: boolean;
  label?: string;
}> = React.memo(({ result, isAssessing, label }) => {
  const progressPercent = result ? (result.progress / 5) * 100 : 0;

  const getProgressColor = (score: number) => {
    if (score <= 1) return "#ef5350"; // red
    if (score <= 2) return "#ff9800"; // orange
    if (score <= 3) return "#ffc107"; // amber
    if (score <= 4) return "#66bb6a"; // light green
    return "#4caf50"; // green
  };

  return (
    <Box
      sx={{
        border: "1px solid var(--border)",
        borderRadius: 2,
        backgroundColor: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          p: 2,
          backgroundColor: "var(--header)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontWeight: "bold", color: "var(--text)", textAlign: "left" }}
        >
          {label ? `${label} - Assessment Score` : "Assessment Score"}
        </Typography>
      </Box>

      <Box
        sx={{
          p: 2,
          height: 180,
          minHeight: 100,
          overflow: "auto",
          resize: "vertical",
        }}
      >
        {isAssessing ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              py: 1,
            }}
          >
            <CircularProgress size={20} />
            <Typography
              variant="body2"
              sx={{ color: "var(--text-secondary)", fontStyle: "italic" }}
            >
              Evaluating conversation...
            </Typography>
          </Box>
        ) : result ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Box sx={{ flex: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={progressPercent}
                  sx={{
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: "var(--border)",
                    "& .MuiLinearProgress-bar": {
                      borderRadius: 5,
                      backgroundColor: getProgressColor(result.progress),
                    },
                  }}
                />
              </Box>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: "bold",
                  color: getProgressColor(result.progress),
                  minWidth: 32,
                }}
              >
                {result.progress}/5
              </Typography>
            </Box>
            <Typography
              variant="body2"
              sx={{
                color: "var(--text)",
                fontStyle: "italic",
                lineHeight: 1.6,
                textAlign: "left",
              }}
            >
              {result.reasoning}
            </Typography>
          </Box>
        ) : (
          <Typography
            variant="body2"
            sx={{
              color: "var(--text-secondary)",
              fontStyle: "italic",
              textAlign: "center",
              py: 1,
            }}
          >
            Start chatting to see assessment scores...
          </Typography>
        )}
      </Box>
    </Box>
  );
});

// Chat panel component
const ChatPanel: React.FC<{
  messages: Message[];
  isLoading: boolean;
  onClear: () => void;
  label?: string;
}> = React.memo(({ messages, isLoading, onClear, label }) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll only when content is loading (streaming response)
  // This prevents scrolling when clearing chat or switching block types
  useEffect(() => {
    if (isLoading && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border)",
        borderRadius: 2,
        backgroundColor: "var(--paper)",
        overflow: "hidden",
        resize: "vertical",
        height: 350,
        minHeight: 200,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          px: 2,
          py: 1,
          borderBottom: "1px solid var(--border)",
          backgroundColor: "var(--header)",
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ color: "var(--text)", fontWeight: "bold" }}
        >
          {label || "Conversation"}
        </Typography>
        <Tooltip title="Clear Chat">
          <IconButton
            size="small"
            onClick={onClear}
            sx={{ color: "var(--text-secondary)" }}
          >
            <RestartAltIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Messages */}
      <Box
        ref={scrollContainerRef}
        sx={{
          flex: 1,
          overflowY: "auto",
          p: 3,
          display: "flex",
          flexDirection: "column",
          gap: 3,
          backgroundColor: "var(--background)",
        }}
      >
        {messages.length === 0 ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              opacity: 0.5,
            }}
          >
            <Typography
              variant="body2"
              sx={{
                color: "var(--text-secondary)",
                textAlign: "center",
                fontStyle: "italic",
              }}
            >
              Send a message to test the prompt versions...
            </Typography>
          </Box>
        ) : (
          messages.map((msg, idx) => (
            <Box key={idx} sx={{ width: "100%" }}>
              {msg.role === "user" ? (
                <UserMessage message={msg.content} />
              ) : (
                <AIResponse
                  message={msg.content}
                  isStreaming={msg.isStreaming === true}
                />
              )}
            </Box>
          ))
        )}

        {isLoading && !messages.some((m) => m.isStreaming) && (
          <Box sx={{ display: "flex", justifyContent: "flex-start", pl: 1 }}>
            <ThinkingIndicator />
          </Box>
        )}
      </Box>
    </Box>
  );
});

// Main PromptPlayground component
const PromptPlayground: React.FC = () => {
  const [playgroundMode, setPlaygroundMode] =
    useState<PlaygroundMode>("reasoning");
  const [compareMode, setCompareMode] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(
    FALLBACK_AVAILABLE_MODELS,
  );
  const [configA, setConfigA] = useState<ConfigurationState>(
    createDefaultConfig("intake", FALLBACK_AVAILABLE_MODELS[0].id),
  );
  const [configB, setConfigB] = useState<ConfigurationState>(
    createDefaultConfig("intake", FALLBACK_AVAILABLE_MODELS[0].id),
  );
  const [inputMessage, setInputMessage] = useState("");
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [assessmentVersions, setAssessmentVersions] = useState<PromptVersion[]>(
    [],
  );
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error" | "info";
  }>({ open: false, message: "", severity: "info" });

  // Chunk buffers for batching streaming updates
  const chunkBufferA = useRef<string | null>(null);
  const chunkBufferB = useRef<string | null>(null);

  // WebSocket state
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Initialize WebSocket URL with auth token
  useEffect(() => {
    const setupWebSocket = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (token && import.meta.env.VITE_WEBSOCKET_URL) {
          setToken(token);
          setWsUrl(
            `${import.meta.env.VITE_WEBSOCKET_URL}?playground_mode=true`,
          );
        }
      } catch {
      }
    };
    setupWebSocket();
  }, []);

  useEffect(() => {
    const fetchAiConfig = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) return;

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/admin/ai_config`,
          {
            headers: { Authorization: token },
          },
        );

        if (!response.ok) return;
        const data = await response.json();

        const rawModelOptions: unknown[] = Array.isArray(data.model_options)
          ? (data.model_options as unknown[])
          : [];

        const parsedModels: ModelOption[] = rawModelOptions
          .filter(
            (
              option: unknown,
            ): option is {
              label: string;
              value: string;
              constraints?: ModelOption["constraints"];
            } =>
              typeof option === "object" &&
              option !== null &&
              typeof (option as { label?: unknown }).label === "string" &&
              typeof (option as { value?: unknown }).value === "string",
          )
          .map((option: { label: string; value: string; constraints?: ModelOption["constraints"] }) => ({
            id: option.value,
            name: option.label,
            constraints: option.constraints,
          }))
          .filter((option: ModelOption) => option.id.length > 0);

        const nextModels =
          parsedModels.length > 0 ? parsedModels : FALLBACK_AVAILABLE_MODELS;
        setAvailableModels(nextModels);

        const selectedModelId =
          typeof data.bedrock_llm_id === "string" &&
          nextModels.some((model: ModelOption) => model.id === data.bedrock_llm_id)
            ? data.bedrock_llm_id
            : nextModels[0].id;

        const selectedModel = nextModels.find(
          (model: ModelOption) => model.id === selectedModelId,
        );
        const defaultMaxTokens = selectedModel?.constraints?.defaultMaxOutputTokens;

        setConfigA((prev) => ({
          ...prev,
          modelId: selectedModelId,
          ...(defaultMaxTokens ? { maxTokens: defaultMaxTokens } : {}),
        }));
        setConfigB((prev) => ({
          ...prev,
          modelId: selectedModelId,
          ...(defaultMaxTokens ? { maxTokens: defaultMaxTokens } : {}),
        }));
      } catch {
      }
    };

    fetchAiConfig();
  }, []);

  const { sendStreamingRequest, isConnected } = useWebSocket(wsUrl, {
    protocols: token ? [token, "chat.v1"] : undefined,
  });

  // Fetch reasoning prompt versions when block type changes
  const fetchPromptVersions = useCallback(async (blockType: string) => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/prompt?category=reasoning&block_type=${blockType}`,
        {
          headers: { Authorization: token },
        },
      );
      if (response.ok) {
        const data = await response.json();
        setPromptVersions(data);
      }
    } catch {
    }
  }, []);

  // Fetch assessment prompt versions when block type changes
  const fetchAssessmentVersions = useCallback(async (blockType: string) => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/prompt?category=assessment&block_type=${blockType}`,
        {
          headers: { Authorization: token },
        },
      );
      if (response.ok) {
        const data = await response.json();
        setAssessmentVersions(data);
      }
    } catch {
    }
  }, []);

  // Fetch versions based on current mode and block type
  useEffect(() => {
    fetchPromptVersions(configA.blockType);
    if (playgroundMode === "assessment") {
      fetchAssessmentVersions(configA.blockType);
    }
  }, [
    configA.blockType,
    playgroundMode,
    fetchPromptVersions,
    fetchAssessmentVersions,
  ]);

  // Load a specific reasoning prompt version
  const loadPromptVersion = useCallback(
    (
      versionId: string,
      setConfig: React.Dispatch<React.SetStateAction<ConfigurationState>>,
    ) => {
      const version = promptVersions.find(
        (v) => v.prompt_version_id === versionId,
      );
      if (version) {
        setConfig((prev) => ({
          ...prev,
          selectedVersionId: versionId,
          systemPrompt: version.prompt_text,
        }));
      }
    },
    [promptVersions],
  );

  // Load a specific assessment prompt version
  const loadAssessmentVersion = useCallback(
    (
      versionId: string,
      setConfig: React.Dispatch<React.SetStateAction<ConfigurationState>>,
    ) => {
      const version = assessmentVersions.find(
        (v) => v.prompt_version_id === versionId,
      );
      if (version) {
        setConfig((prev) => ({
          ...prev,
          assessmentVersionId: versionId,
          assessmentPrompt: version.prompt_text,
        }));
      }
    },
    [assessmentVersions],
  );

  // Auto-load active reasoning version when versions are fetched
  useEffect(() => {
    if (promptVersions.length > 0) {
      const activeVersion =
        promptVersions.find((v) => v.is_active) || promptVersions[0];

      if (
        !configA.selectedVersionId ||
        !promptVersions.some(
          (v) => v.prompt_version_id === configA.selectedVersionId,
        )
      ) {
        loadPromptVersion(activeVersion.prompt_version_id, setConfigA);
      }

      if (
        compareMode &&
        (!configB.selectedVersionId ||
          !promptVersions.some(
            (v) => v.prompt_version_id === configB.selectedVersionId,
          ))
      ) {
        loadPromptVersion(activeVersion.prompt_version_id, setConfigB);
      }
    }
  }, [
    promptVersions,
    loadPromptVersion,
    compareMode,
    configA.selectedVersionId,
    configB.selectedVersionId,
  ]);

  // Auto-load active assessment version when assessment versions are fetched
  useEffect(() => {
    if (playgroundMode === "assessment" && assessmentVersions.length > 0) {
      const activeVersion =
        assessmentVersions.find((v) => v.is_active) || assessmentVersions[0];

      if (
        !configA.assessmentVersionId ||
        !assessmentVersions.some(
          (v) => v.prompt_version_id === configA.assessmentVersionId,
        )
      ) {
        loadAssessmentVersion(activeVersion.prompt_version_id, setConfigA);
      }

      if (
        compareMode &&
        (!configB.assessmentVersionId ||
          !assessmentVersions.some(
            (v) => v.prompt_version_id === configB.assessmentVersionId,
          ))
      ) {
        loadAssessmentVersion(activeVersion.prompt_version_id, setConfigB);
      }
    }
  }, [
    playgroundMode,
    assessmentVersions,
    loadAssessmentVersion,
    compareMode,
    configA.assessmentVersionId,
    configB.assessmentVersionId,
  ]);

  // Save current prompt version
  const savePromptVersion = useCallback(
    async (config: ConfigurationState) => {
      if (!config.selectedVersionId) return;

      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) {
          setSnackbar({
            open: true,
            message: "Not authenticated",
            severity: "error",
          });
          return;
        }

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/admin/prompt`,
          {
            method: "PUT",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              prompt_version_id: config.selectedVersionId,
              prompt_text: config.systemPrompt,
            }),
          },
        );
        if (response.ok) {
          setSnackbar({
            open: true,
            message: "Updated in-place.",
            severity: "success",
          });
          fetchPromptVersions(config.blockType);
        } else {
          throw new Error("Failed to save");
        }
      } catch {
        setSnackbar({
          open: true,
          message: "Failed to save version",
          severity: "error",
        });
      }
    },
    [fetchPromptVersions],
  );

  // Save assessment prompt version
  const saveAssessmentVersion = useCallback(
    async (config: ConfigurationState) => {
      if (!config.assessmentVersionId) return;

      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) {
          setSnackbar({
            open: true,
            message: "Not authenticated",
            severity: "error",
          });
          return;
        }

        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/admin/prompt`,
          {
            method: "PUT",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              prompt_version_id: config.assessmentVersionId,
              prompt_text: config.assessmentPrompt,
            }),
          },
        );
        if (response.ok) {
          setSnackbar({
            open: true,
            message: "Updated in-place.",
            severity: "success",
          });
          fetchAssessmentVersions(config.blockType);
        } else {
          throw new Error("Failed to save");
        }
      } catch {
        setSnackbar({
          open: true,
          message: "Failed to save assessment version",
          severity: "error",
        });
      }
    },
    [fetchAssessmentVersions],
  );
  // Run assessment on a config's conversation
  const runAssessment = useCallback(
    (
      config: ConfigurationState,
      setConfig: React.Dispatch<React.SetStateAction<ConfigurationState>>,
    ) => {
      if (!config.assessmentPrompt || config.messages.length === 0) return;

      setConfig((prev) => ({ ...prev, isAssessing: true }));

      sendStreamingRequest(
        "playground_assess",
        {
          block_type: config.blockType,
          session_id: config.sessionId,
          custom_prompt: config.assessmentPrompt,
        },
        {
          onComplete: (data) => {
            const result = data as unknown as AssessmentResult;
            setConfig((prev) => ({
              ...prev,
              isAssessing: false,
              assessmentResult: {
                progress:
                  typeof result.progress === "number" ? result.progress : 0,
                reasoning: result.reasoning || "No reasoning provided.",
                unlocked: result.unlocked || false,
              },
            }));
          },
          onError: (errorMsg) => {
            setConfig((prev) => ({ ...prev, isAssessing: false }));
            setSnackbar({
              open: true,
              message: `Assessment error: ${errorMsg}`,
              severity: "error",
            });
          },
        },
      );
    },
    [sendStreamingRequest],
  );

  // Send message handler
  const handleSendMessage = useCallback(async () => {
    if (!inputMessage.trim() || !isConnected) return;

    const message = inputMessage.trim();
    setInputMessage("");

    // Add user message to config A
    setConfigA((prev) => ({
      ...prev,
      messages: [...prev.messages, { role: "user", content: message }],
      isLoading: true,
    }));

    // If compare mode, also add to config B
    if (compareMode) {
      setConfigB((prev) => ({
        ...prev,
        messages: [...prev.messages, { role: "user", content: message }],
        isLoading: true,
      }));
    }

    // Send request for Config A
    sendStreamingRequest(
      "playground_test",
      {
        message_content: message,
        block_type: configA.blockType,
        session_id: configA.sessionId,
        custom_prompt: configA.systemPrompt,
        model_id: configA.modelId,
        temperature: configA.temperature,
        top_p: configA.topP,
        max_tokens: configA.maxTokens,
        case_context: configA.caseContext,
      },
      {
        onStart: () => {
          setConfigA((prev) => ({
            ...prev,
            messages: [
              ...prev.messages,
              { role: "assistant", content: "", isStreaming: true },
            ],
          }));
        },
        onChunk: (content) => {
          // Batch chunks using RAF to reduce render frequency
          if (!chunkBufferA.current) {
            chunkBufferA.current = content;
            requestAnimationFrame(() => {
              const batch = chunkBufferA.current;
              chunkBufferA.current = null;

              setConfigA((prev) => {
                const msgs = [...prev.messages];
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.role === "assistant") {
                  msgs[msgs.length - 1] = {
                    ...lastMsg,
                    content: lastMsg.content + batch,
                  };
                }
                return { ...prev, messages: msgs };
              });
            });
          } else {
            chunkBufferA.current += content;
          }
        },
        onComplete: () => {
          setConfigA((prev) => {
            const msgs = [...prev.messages];
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              msgs[msgs.length - 1] = { ...lastMsg, isStreaming: false };
            }
            const updated = { ...prev, messages: msgs, isLoading: false };

            // Auto-run assessment after AI response completes
            if (playgroundMode === "assessment") {
              // Use setTimeout to ensure state is committed before assessment
              setTimeout(() => runAssessment(updated, setConfigA), 100);
            }

            return updated;
          });
        },
        onError: (errorMsg) => {
          setSnackbar({
            open: true,
            message: `Error: ${errorMsg}`,
            severity: "error",
          });
          setConfigA((prev) => ({ ...prev, isLoading: false }));
        },
      },
    );

    // Send request for Config B if in compare mode
    if (compareMode) {
      sendStreamingRequest(
        "playground_test",
        {
          message_content: message,
          block_type: configB.blockType,
          session_id: configB.sessionId,
          custom_prompt: configB.systemPrompt,
          model_id: configB.modelId,
          temperature: configB.temperature,
          top_p: configB.topP,
          max_tokens: configB.maxTokens,
          case_context: configB.caseContext,
        },
        {
          onStart: () => {
            setConfigB((prev) => ({
              ...prev,
              messages: [
                ...prev.messages,
                { role: "assistant", content: "", isStreaming: true },
              ],
            }));
          },
          onChunk: (content) => {
            // Batch chunks using RAF to reduce render frequency
            if (!chunkBufferB.current) {
              chunkBufferB.current = content;
              requestAnimationFrame(() => {
                const batch = chunkBufferB.current;
                chunkBufferB.current = null;

                setConfigB((prev) => {
                  const msgs = [...prev.messages];
                  const lastMsg = msgs[msgs.length - 1];
                  if (lastMsg && lastMsg.role === "assistant") {
                    msgs[msgs.length - 1] = {
                      ...lastMsg,
                      content: lastMsg.content + batch,
                    };
                  }
                  return { ...prev, messages: msgs };
                });
              });
            } else {
              chunkBufferB.current += content;
            }
          },
          onComplete: () => {
            setConfigB((prev) => {
              const msgs = [...prev.messages];
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && lastMsg.role === "assistant") {
                msgs[msgs.length - 1] = { ...lastMsg, isStreaming: false };
              }
              const updated = { ...prev, messages: msgs, isLoading: false };

              // Auto-run assessment after AI response completes
              if (playgroundMode === "assessment") {
                setTimeout(() => runAssessment(updated, setConfigB), 100);
              }

              return updated;
            });
          },
          onError: () => {
            setConfigB((prev) => ({ ...prev, isLoading: false }));
          },
        },
      );
    }
  }, [
    inputMessage,
    isConnected,
    configA,
    configB,
    compareMode,
    sendStreamingRequest,
    playgroundMode,
    runAssessment,
  ]);

  // Handle config changes with session rotation for block type
  const handleConfigAChange = (updates: Partial<ConfigurationState>) => {
    setConfigA((prev) => {
      const newConfig = { ...prev, ...updates };
      // If blockType changed, rotate test ID and clear messages/assessment
      if (updates.blockType && updates.blockType !== prev.blockType) {
        newConfig.sessionId = generateTestId();
        newConfig.messages = [];
        newConfig.assessmentResult = null;

        // If in compare mode, synchronize Config B's block category
        if (compareMode) {
          setConfigB((prevB) => ({
            ...prevB,
            blockType: updates.blockType!,
            sessionId: generateTestId(),
            messages: [],
            assessmentResult: null,
          }));
        }
      }
      return newConfig;
    });
  };

  const handleConfigBChange = (updates: Partial<ConfigurationState>) => {
    setConfigB((prev) => {
      const newConfig = { ...prev, ...updates };
      // If blockType changed, rotate test ID and clear messages/assessment
      if (updates.blockType && updates.blockType !== prev.blockType) {
        newConfig.sessionId = generateTestId();
        newConfig.messages = [];
        newConfig.assessmentResult = null;

        // If in compare mode, synchronize Config A's block category
        if (compareMode) {
          setConfigA((prevA) => ({
            ...prevA,
            blockType: updates.blockType!,
            sessionId: generateTestId(),
            messages: [],
            assessmentResult: null,
          }));
        }
      }
      return newConfig;
    });
  };

  // Clear chat handlers
  const handleClearA = useCallback(() => {
    setConfigA((prev) => ({
      ...prev,
      messages: [],
      sessionId: generateTestId(),
      assessmentResult: null,
    }));
  }, []);

  const handleClearB = useCallback(() => {
    setConfigB((prev) => ({
      ...prev,
      messages: [],
      sessionId: generateTestId(),
      assessmentResult: null,
    }));
  }, []);

  // Handle mode change
  const handleModeChange = (
    _: React.MouseEvent<HTMLElement>,
    newMode: PlaygroundMode | null,
  ) => {
    if (newMode && newMode !== playgroundMode) {
      setPlaygroundMode(newMode);
      // Reset conversations and assessment state on mode change
      setConfigA((prev) => ({
        ...prev,
        messages: [],
        sessionId: generateTestId(),
        assessmentResult: null,
        isAssessing: false,
      }));
      setConfigB((prev) => ({
        ...prev,
        messages: [],
        sessionId: generateTestId(),
        assessmentResult: null,
        isAssessing: false,
      }));
    }
  };

  // Toggle compare mode
  const toggleCompareMode = () => {
    if (!compareMode) {
      setConfigB(createDefaultConfig(configA.blockType));
    }
    setCompareMode(!compareMode);
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Typography
            variant="h5"
            sx={{ fontWeight: "bold", color: "var(--text)" }}
          >
            Prompt Playground
          </Typography>
          <ToggleButtonGroup
            value={playgroundMode}
            exclusive
            onChange={handleModeChange}
            size="small"
            sx={{
              "& .MuiToggleButton-root": {
                textTransform: "none",
                color: "var(--text-secondary)",
                borderColor: "var(--border)",
                px: 2,
                py: 0.5,
                "&.Mui-selected": {
                  color: "var(--primary)",
                  backgroundColor:
                    "color-mix(in srgb, var(--primary) 12%, transparent)",
                  borderColor: "var(--primary)",
                  "&:hover": {
                    backgroundColor:
                      "color-mix(in srgb, var(--primary) 18%, transparent)",
                  },
                },
              },
            }}
          >
            <ToggleButton value="reasoning">Reasoning</ToggleButton>
            <ToggleButton value="assessment">Assessment</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Button
          variant={compareMode ? "outlined" : "contained"}
          startIcon={compareMode ? <CloseIcon /> : <AddIcon />}
          onClick={toggleCompareMode}
          sx={{
            textTransform: "none",
            borderRadius: 2,
            backgroundColor: compareMode ? "transparent" : "var(--primary)",
            borderColor: "var(--primary)",
            color: compareMode ? "var(--primary)" : "white",
            "&:hover": {
              backgroundColor: compareMode
                ? "rgba(var(--primary-rgb), 0.04)"
                : "var(--primary-hover)",
              borderColor: "var(--primary)",
            },
          }}
        >
          {compareMode ? "Exit Compare Mode" : "Compare"}
        </Button>
      </Box>

      {/* Instructions Note */}
      <Alert
        severity="info"
        icon={false}
        sx={{
          backgroundColor: "transparent",
          color: "var(--text-secondary)",
          p: 0,
          fontSize: "0.85rem",
          "& .MuiAlert-message": { p: 0 },
        }}
      >
        Note: Edits here are in-place. Create new versions in sidebar blocks.
      </Alert>

      {/* Main Content Area - Split if compare mode */}
      <Box
        sx={{
          display: "flex",
          gap: 2,
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* Left Panel (Config A) */}
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            overflowY: "auto",
          }}
        >
          <ModelConfigSection
            config={configA}
            onConfigChange={handleConfigAChange}
            availableModels={availableModels}
            label={compareMode ? "Config A" : undefined}
          />
          {playgroundMode === "reasoning" ? (
            <SystemPromptSection
              config={configA}
              onConfigChange={handleConfigAChange}
              promptVersions={promptVersions}
              onLoadVersion={(id) => loadPromptVersion(id, setConfigA)}
              onSave={() => savePromptVersion(configA)}
              label={compareMode ? "Config A" : undefined}
              compareMode={compareMode}
            />
          ) : (
            <AssessmentPromptSection
              config={configA}
              onConfigChange={handleConfigAChange}
              assessmentVersions={assessmentVersions}
              onLoadVersion={(id) => loadAssessmentVersion(id, setConfigA)}
              onSave={() => saveAssessmentVersion(configA)}
              label={compareMode ? "Config A" : undefined}
              compareMode={compareMode}
            />
          )}
          <MockCaseContextSection
            config={configA}
            onConfigChange={handleConfigAChange}
            label={compareMode ? "Context A" : undefined}
          />
          {playgroundMode === "assessment" && (
            <AssessmentScorePanel
              result={configA.assessmentResult}
              isAssessing={configA.isAssessing}
              label={compareMode ? "Score A" : undefined}
            />
          )}
          <ChatPanel
            messages={configA.messages}
            isLoading={configA.isLoading}
            onClear={handleClearA}
            label={compareMode ? "Conversation A" : undefined}
          />
        </Box>

        {/* Right Panel (Config B) - Only if compare mode */}
        {compareMode && (
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              overflowY: "auto",
              borderLeft: "1px dashed var(--border)",
              pl: 2,
            }}
          >
            <ModelConfigSection
              config={configB}
              onConfigChange={handleConfigBChange}
              availableModels={availableModels}
              label="Config B"
            />
            {playgroundMode === "reasoning" ? (
              <SystemPromptSection
                config={configB}
                onConfigChange={handleConfigBChange}
                promptVersions={promptVersions}
                onLoadVersion={(id) => loadPromptVersion(id, setConfigB)}
                onSave={() => savePromptVersion(configB)}
                label="Config B"
                compareMode={compareMode}
              />
            ) : (
              <AssessmentPromptSection
                config={configB}
                onConfigChange={handleConfigBChange}
                assessmentVersions={assessmentVersions}
                onLoadVersion={(id) => loadAssessmentVersion(id, setConfigB)}
                onSave={() => saveAssessmentVersion(configB)}
                label="Config B"
                compareMode={compareMode}
              />
            )}
            <MockCaseContextSection
              config={configB}
              onConfigChange={handleConfigBChange}
              label="Context B"
            />
            {playgroundMode === "assessment" && (
              <AssessmentScorePanel
                result={configB.assessmentResult}
                isAssessing={configB.isAssessing}
                label="Score B"
              />
            )}
            <ChatPanel
              messages={configB.messages}
              isLoading={configB.isLoading}
              onClear={handleClearB}
              label="Conversation B"
            />
          </Box>
        )}
      </Box>

      {/* Shared Input Area */}
      <Box
        sx={{
          p: 2,
          borderTop: "1px solid var(--border)",
          backgroundColor: "var(--paper)",
          display: "flex",
          gap: 2,
          alignItems: "flex-end",
        }}
      >
        <TextField
          fullWidth
          multiline
          maxRows={4}
          placeholder={
            compareMode
              ? "Type a message to test both configurations..."
              : "Type a message to test the prompt..."
          }
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
            }
          }}
          disabled={!isConnected || configA.isLoading || configB.isLoading}
          sx={{
            "& .MuiOutlinedInput-root": {
              borderRadius: 3,
              color: "var(--text)",
              backgroundColor: "var(--background)",
              "& fieldset": { borderColor: "var(--border)" },
              "&:hover fieldset": { borderColor: "var(--primary)" },
              "&.Mui-focused fieldset": { borderColor: "var(--primary)" },
            },
          }}
        />
        <Button
          variant="contained"
          onClick={handleSendMessage}
          disabled={
            !inputMessage.trim() ||
            !isConnected ||
            configA.isLoading ||
            configB.isLoading
          }
          sx={{
            borderRadius: "50%",
            minWidth: 48,
            width: 48,
            height: 48,
            p: 0,
            backgroundColor: "var(--primary)",
            "&:hover": {
              backgroundColor: "var(--primary-hover)",
            },
            "&.Mui-disabled": {
              backgroundColor: "var(--border)",
              color: "var(--text-secondary)",
            },
          }}
        >
          <SendIcon />
        </Button>
      </Box>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={8000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default PromptPlayground;
