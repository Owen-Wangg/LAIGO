import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  CircularProgress,
  Snackbar,
  Alert,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Divider,
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import { fetchAuthSession } from "aws-amplify/auth";

interface ModelOption {
  label: string;
  value: string;
  constraints?: {
    maxOutputTokens: number;
    defaultMaxOutputTokens: number;
    temperatureRange: [number, number];
    topPRange: [number, number];
  };
}

const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  {
    label: "Claude Sonnet 5.5",
    value: "us.anthropic.claude-sonnet-5-5",
    constraints: {
      maxOutputTokens: 128000,
      defaultMaxOutputTokens: 4096,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
  {
    label: "Llama 3 70b Instruct",
    value: "meta.llama3-70b-instruct-v1:0",
    constraints: {
      maxOutputTokens: 8192,
      defaultMaxOutputTokens: 2000,
      temperatureRange: [0, 1.0],
      topPRange: [0, 1.0],
    },
  },
];

const ModelConfig = () => {
  const [bedrockLlmId, setBedrockLlmId] = useState("");
  const [temperature, setTemperature] = useState(0.5);
  const [topP, setTopP] = useState(0.9);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [messageLimit, setMessageLimit] = useState("Infinity");
  const [fileSizeLimit, setFileSizeLimit] = useState("500");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(
    FALLBACK_MODEL_OPTIONS,
  );
  const [maxTokensLimit, setMaxTokensLimit] = useState(2048);
  const [isAiConfigLoading, setIsAiConfigLoading] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Error States
  const [genericError, setGenericError] = useState<string | null>(null);
  const [messageLimitError, setMessageLimitError] = useState<string | null>(
    null,
  );
  const [fileSizeError, setFileSizeError] = useState<string | null>(null);
  const [temperatureError, setTemperatureError] = useState<string | null>(null);
  const [topPError, setTopPError] = useState<string | null>(null);
  const [maxTokensError, setMaxTokensError] = useState<string | null>(null);

  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({ open: false, message: "", severity: "success" });

  const selectedModelConstraints =
    modelOptions.find((option) => option.value === bedrockLlmId)?.constraints;
  // Optional-chain the array access too: some models omit range constraints
  // entirely, and `undefined[0]` would otherwise crash the whole page.
  const temperatureMin = selectedModelConstraints?.temperatureRange?.[0] ?? 0;
  const temperatureMax = selectedModelConstraints?.temperatureRange?.[1] ?? 1;
  const topPMin = selectedModelConstraints?.topPRange?.[0] ?? 0;
  const topPMax = selectedModelConstraints?.topPRange?.[1] ?? 1;

  const fetchAiConfig = useCallback(async () => {
    setIsAiConfigLoading(true);
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("No auth token");

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/ai_config`,
        { headers: { Authorization: token } },
      );
      if (!response.ok) throw new Error("Failed to fetch AI config");
      const data = await response.json();

      const parsedModelOptions = Array.isArray(data.model_options)
        ? data.model_options
            .filter(
              (option: unknown): option is ModelOption =>
                typeof option === "object" &&
                option !== null &&
                typeof (option as ModelOption).label === "string" &&
                typeof (option as ModelOption).value === "string",
            )
            .filter((option: ModelOption) => option.value.length > 0)
        : [];

      setModelOptions(
        parsedModelOptions.length > 0
          ? parsedModelOptions
          : FALLBACK_MODEL_OPTIONS,
      );
      setBedrockLlmId(data.bedrock_llm_id || "");
      setTemperature(parseFloat(data.temperature) || 0.5);
      setTopP(parseFloat(data.top_p) || 0.9);
      setMaxTokens(parseInt(data.max_tokens) || 2048);
      setMessageLimit(data.message_limit || "Infinity");
      setFileSizeLimit(data.file_size_limit || "500");
    } catch (err) {
      setGenericError("Failed to load configuration");
    } finally {
      setIsAiConfigLoading(false);
    }
  }, []);

  const saveAiConfig = async () => {
    // Clear previous errors
    setGenericError(null);
    setMessageLimitError(null);
    setFileSizeError(null);
    setTemperatureError(null);
    setTopPError(null);
    setMaxTokensError(null);

    let hasValidationErrors = false;

    // Validate Temperature
    if (temperature < temperatureMin || temperature > temperatureMax) {
      setTemperatureError(`Must be between ${temperatureMin} and ${temperatureMax}`);
      hasValidationErrors = true;
    }

    // Validate Top P
    if (topP < topPMin || topP > topPMax) {
      setTopPError(`Must be between ${topPMin} and ${topPMax}`);
      hasValidationErrors = true;
    }

    // Validate Max Tokens
    if (maxTokens <= 0 || maxTokens > maxTokensLimit) {
      setMaxTokensError(`Must be between 1 and ${maxTokensLimit}`);
      hasValidationErrors = true;
    }

    // Validate Message Limit
    const isInfinity = messageLimit === "Infinity";
    const numMsgLimit = parseInt(messageLimit);
    if (!isInfinity && (isNaN(numMsgLimit) || numMsgLimit < 10)) {
      setMessageLimitError("Must be 'Infinity' or a number ≥ 10");
      hasValidationErrors = true;
    }

    // Validate File Size Limit
    const numFileLimit = parseInt(fileSizeLimit);
    if (isNaN(numFileLimit) || numFileLimit <= 0 || numFileLimit > 500) {
      setFileSizeError("Must be a positive number up to 500");
      hasValidationErrors = true;
    }

    if (hasValidationErrors) return;

    setIsSavingConfig(true);
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("No auth token");

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/ai_config`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({
            bedrock_llm_id: bedrockLlmId,
            temperature: temperature,
            top_p: topP,
            max_tokens: maxTokens,
            message_limit: messageLimit,
            file_size_limit: fileSizeLimit,
          }),
        },
      );
      if (!response.ok) throw new Error("Failed to save configuration");

      setSnackbar({
        open: true,
        message: "Configuration saved successfully!",
        severity: "success",
      });
    } catch (err) {
      setGenericError("Failed to save configuration");
    } finally {
      setIsSavingConfig(false);
    }
  };

  useEffect(() => {
    fetchAiConfig();
  }, [fetchAiConfig]);

  // Real-time validation effects
  useEffect(() => {
    if (
      isNaN(temperature) ||
      temperature < temperatureMin ||
      temperature > temperatureMax
    ) {
      setTemperatureError(`Must be between ${temperatureMin} and ${temperatureMax}`);
    } else {
      setTemperatureError(null);
    }
  }, [temperature, temperatureMin, temperatureMax]);

  useEffect(() => {
    if (isNaN(topP) || topP < topPMin || topP > topPMax) {
      setTopPError(`Must be between ${topPMin} and ${topPMax}`);
    } else {
      setTopPError(null);
    }
  }, [topP, topPMin, topPMax]);

  useEffect(() => {
    if (isNaN(maxTokens) || maxTokens <= 0 || maxTokens > maxTokensLimit) {
      setMaxTokensError(`Must be between 1 and ${maxTokensLimit}`);
    } else {
      setMaxTokensError(null);
    }
  }, [maxTokens, maxTokensLimit]);

  useEffect(() => {
    const selectedModel = modelOptions.find((option) => option.value === bedrockLlmId);
    const limit = selectedModel?.constraints?.maxOutputTokens ?? 2048;
    setMaxTokensLimit(limit);
  }, [bedrockLlmId, modelOptions]);

  useEffect(() => {
    const isInfinity = messageLimit === "Infinity";
    const numLimit = parseInt(messageLimit);

    if (
      !isInfinity &&
      messageLimit.trim() !== "" &&
      (isNaN(numLimit) || numLimit < 10)
    ) {
      setMessageLimitError("Must be 'Infinity' or a number ≥ 10");
    } else {
      setMessageLimitError(null);
    }
  }, [messageLimit]);

  useEffect(() => {
    const numLimit = parseInt(fileSizeLimit);
    if (
      fileSizeLimit.trim() !== "" &&
      (isNaN(numLimit) || numLimit <= 0 || numLimit > 500)
    ) {
      setFileSizeError("Must be a positive number up to 500");
    } else {
      setFileSizeError(null);
    }
  }, [fileSizeLimit]);

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          width: "100%",
          backgroundColor: "var(--paper)",
          border: "1px solid var(--border)",
          borderRadius: 2,
          p: 4,
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <Typography
          variant="h6"
          sx={{ color: "var(--text)", fontWeight: "bold", textAlign: "left" }}
        >
          General Settings
        </Typography>

        {isAiConfigLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Section 1: AI Model Configuration */}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Typography
                variant="subtitle1"
                sx={{
                  color: "var(--text)",
                  fontWeight: 600,
                  textAlign: "left",
                }}
              >
                AI Model Settings
              </Typography>
              <Divider />

              <FormControl fullWidth>
                <InputLabel
                  id="model-select-label"
                  sx={{ color: "var(--text-secondary)" }}
                >
                  Bedrock Model
                </InputLabel>
                <Select
                  labelId="model-select-label"
                  value={
                    modelOptions.some((o) => o.value === bedrockLlmId)
                      ? bedrockLlmId
                      : ""
                  }
                  label="Bedrock Model"
                  onChange={(e) => {
                                      const newModelId = e.target.value;
                                      setBedrockLlmId(newModelId);
                                      const selectedModel = modelOptions.find(
                                        (m) => m.value === newModelId,
                                      );
                                      if (selectedModel?.constraints) {
                                        setMaxTokensLimit(selectedModel.constraints.maxOutputTokens);
                                        setMaxTokens(
                                          selectedModel.constraints.defaultMaxOutputTokens,
                                        );
                                      }
                                    }}
                  sx={{
                    color: "var(--text)",
                    backgroundColor: "var(--background)",
                    textAlign: "left",
                    "& .MuiOutlinedInput-notchedOutline": {
                      borderColor: "var(--border)",
                    },
                    "&:hover .MuiOutlinedInput-notchedOutline": {
                      borderColor: "var(--border)",
                    },
                    "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                      borderColor: "var(--primary)",
                    },
                    "& .MuiSvgIcon-root": { color: "var(--text)" },
                  }}
                >
                  {modelOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <Box sx={{ display: "flex", gap: 2 }}>
                <TextField
                  label="Temperature"
                  type="number"
                  inputProps={{ step: 0.1, min: temperatureMin, max: temperatureMax }}
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  error={!!temperatureError}
                  helperText={temperatureError}
                  fullWidth
                  variant="outlined"
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      color: "var(--text)",
                      backgroundColor: "var(--background)",
                      "& fieldset": { borderColor: "var(--border)" },
                    },
                    "& .MuiInputLabel-root": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiInputLabel-root.Mui-error": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiFormHelperText-root:not(.Mui-error)": {
                      color: "var(--text-secondary)",
                    },
                  }}
                />
                <TextField
                  label="Top P"
                  type="number"
                  inputProps={{ step: 0.1, min: topPMin, max: topPMax }}
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                  error={!!topPError}
                  helperText={topPError}
                  fullWidth
                  variant="outlined"
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      color: "var(--text)",
                      backgroundColor: "var(--background)",
                      "& fieldset": { borderColor: "var(--border)" },
                    },
                    "& .MuiInputLabel-root": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiInputLabel-root.Mui-error": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiFormHelperText-root:not(.Mui-error)": {
                      color: "var(--text-secondary)",
                    },
                  }}
                />

                <TextField
                  label="Max Tokens"
                  type="number"
                  inputProps={{ min: 1, max: maxTokensLimit }}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                  error={!!maxTokensError}
                  helperText={maxTokensError}
                  fullWidth
                  variant="outlined"
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      color: "var(--text)",
                      backgroundColor: "var(--background)",
                      "& fieldset": { borderColor: "var(--border)" },
                    },
                    "& .MuiInputLabel-root": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiInputLabel-root.Mui-error": {
                      color: "var(--text-secondary)",
                    },
                    "& .MuiFormHelperText-root:not(.Mui-error)": {
                      color: "var(--text-secondary)",
                    },
                  }}
                />
              </Box>
            </Box>

            {/* Section 2: Usage Limits */}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Typography
                variant="subtitle1"
                sx={{
                  color: "var(--text)",
                  fontWeight: 600,
                  textAlign: "left",
                }}
              >
                Usage Limits
              </Typography>
              <Divider />

              <TextField
                label="Daily Message Limit (per user)"
                type="text"
                error={!!messageLimitError}
                helperText={messageLimitError}
                value={messageLimit}
                onChange={(e) => setMessageLimit(e.target.value)}
                fullWidth
                variant="outlined"
                sx={{
                  "& .MuiOutlinedInput-root": {
                    color: "var(--text)",
                    backgroundColor: "var(--background)",
                    "& fieldset": { borderColor: "var(--border)" },
                  },
                  "& .MuiInputLabel-root": {
                    color: "var(--text-secondary)",
                  },
                  "& .MuiInputLabel-root.Mui-error": {
                    color: "var(--text-secondary)",
                  },
                  "& .MuiFormHelperText-root:not(.Mui-error)": {
                    color: "var(--text-secondary)",
                  },
                }}
              />
            </Box>

            {/* Section 3: File Upload Settings */}
            <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Typography
                variant="subtitle1"
                sx={{
                  color: "var(--text)",
                  fontWeight: 600,
                  textAlign: "left",
                }}
              >
                File Upload Settings
              </Typography>
              <Divider />

              <TextField
                label="Max Audio File Size (MB)"
                type="number"
                error={!!fileSizeError}
                helperText={
                  fileSizeError ||
                  "Maximum size for audio uploads in Megabytes (Max 500)"
                }
                value={fileSizeLimit}
                onChange={(e) => setFileSizeLimit(e.target.value)}
                fullWidth
                variant="outlined"
                sx={{
                  "& .MuiOutlinedInput-root": {
                    color: "var(--text)",
                    backgroundColor: "var(--background)",
                    "& fieldset": { borderColor: "var(--border)" },
                  },
                  "& .MuiInputLabel-root": {
                    color: "var(--text-secondary)",
                  },
                  "& .MuiFormHelperText-root:not(.Mui-error)": {
                    color: "var(--text-secondary)",
                  },
                }}
              />
            </Box>

            <Button
              variant="contained"
              startIcon={
                isSavingConfig ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <SaveIcon />
                )
              }
              onClick={saveAiConfig}
              disabled={
                isSavingConfig ||
                !!messageLimitError ||
                !!fileSizeError ||
                !!temperatureError ||
                !!topPError ||
                !!maxTokensError
              }
              sx={{
                alignSelf: "flex-end",
                backgroundColor: "var(--primary)",
                color: "var(--text)",
                fontWeight: "bold",
                "&:hover": {
                  backgroundColor: "var(--primary)",
                  opacity: 0.9,
                },
              }}
            >
              {isSavingConfig ? "Saving..." : "Save Configuration"}
            </Button>
          </Box>
        )}
      </Paper>
      <Snackbar
        open={snackbar.open}
        autoHideDuration={8000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: "100%" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
      <Snackbar
        open={!!genericError}
        autoHideDuration={6000}
        onClose={() => setGenericError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setGenericError(null)}
          severity="error"
          sx={{ width: "100%" }}
        >
          {genericError}
        </Alert>
      </Snackbar>
    </>
  );
};

export default ModelConfig;
