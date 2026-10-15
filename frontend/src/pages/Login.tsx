import { useState } from "react";
import {
  TextField,
  Button,
  Typography,
  Box,
  CircularProgress,
  Link,
  IconButton,
  InputAdornment,
  Snackbar,
  Alert,
} from "@mui/material";
import type { AlertColor } from "@mui/material";
import {
  Visibility,
  VisibilityOff,
  Email,
  Lock,
  Gavel,
} from "@mui/icons-material";
import {
  signIn,
  signUp,
  resetPassword,
  confirmResetPassword,
  confirmSignUp,
} from "aws-amplify/auth";

const Login = () => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [step, setStep] = useState("requestReset");
  const [isConfirmingSignUp, setIsConfirmingSignUp] = useState(false);
  const [signUpErrors, setSignUpErrors] = useState<{
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
  }>({});

  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity?: AlertColor;
  }>({ open: false, message: "", severity: "info" });

  // Password validation state
  const [passwordRequirements, setPasswordRequirements] = useState({
    minLength: false,
    hasLowercase: false,
    hasUppercase: false,
    hasNumber: false,
    hasSpecialChar: false,
    passwordsMatch: false,
  });

  // Check password requirements
  const checkPasswordRequirements = (
    password: string,
    confirmPwd: string = confirmPassword,
  ) => {
    setPasswordRequirements({
      minLength: password.length >= 12,
      hasLowercase: /[a-z]/.test(password),
      hasUppercase: /[A-Z]/.test(password),
      hasNumber: /\d/.test(password),
      hasSpecialChar: /[!@#$%^&*(),.?":{}|<>]/.test(password),
      passwordsMatch: password === confirmPwd && password !== "",
    });
  };

  const cleanErrorMessage = (message: string) => {
    // Strips common Cognito Lambda trigger error prefixes
    // Format: "[TriggerName] failed with error [Real Message]"
    return message.replace(/^\w+ failed with error\s+/, "");
  };

  // Maps sign-in errors to user-facing messages. Unknown-account and
  // wrong-password outcomes are collapsed into a single generic message so the
  // response is uniform regardless of whether the account exists; actionable,
  // non-revealing states keep their specific guidance.
  const signInErrorMessage = (err: Error) => {
    switch (err.name) {
      case "UserNotFoundException":
      case "NotAuthorizedException":
        return "Incorrect email or password.";
      case "UserNotConfirmedException":
        return "Please confirm your account before signing in.";
      case "PasswordResetRequiredException":
        return "A password reset is required before you can sign in.";
      default:
        return cleanErrorMessage(err.message) || "Something went wrong";
    }
  };

  const validateSignUpForm = () => {
    const errors: {
      firstName?: string;
      lastName?: string;
      email?: string;
      password?: string;
      confirmPassword?: string;
    } = {};

    if (!firstName.trim()) {
      errors.firstName = "First name is required";
    }

    if (!lastName.trim()) {
      errors.lastName = "Last name is required";
    }

    if (!email.trim()) {
      errors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = "Enter a valid email address";
    }

    if (!password) {
      errors.password = "Password is required";
    } else {
      const passwordMeetsRequirements =
        password.length >= 12 &&
        /[a-z]/.test(password) &&
        /[A-Z]/.test(password) &&
        /\d/.test(password) &&
        /[!@#$%^&*(),.?":{}|<>]/.test(password);

      if (!passwordMeetsRequirements) {
        errors.password = "Password does not meet the required complexity";
      }
    }

    if (!confirmPassword) {
      errors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match";
    }

    setSignUpErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isSignUp) {
        if (!validateSignUpForm()) {
          setLoading(false);
          return;
        }

        await signUp({
          username: email,
          password,
          options: {
            userAttributes: {
              email,
              given_name: firstName,
              family_name: lastName,
            },
          },
        });
        setSnackbar({
          open: true,
          message: "Sign up successful. Check your email to confirm.",
          severity: "success",
        });
        setIsConfirmingSignUp(true); // Set the step to confirmation after sign-up
      } else {
        const user = await signIn({ username: email, password });
        if (user.isSignedIn) {
          window.location.reload();
        }
      }
    } catch (err) {
      setSnackbar({
        open: true,
        message: isSignUp
          ? cleanErrorMessage((err as Error).message) || "Something went wrong"
          : signInErrorMessage(err as Error),
        severity: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await confirmSignUp({
        username: email,
        confirmationCode,
      });
      setSnackbar({
        open: true,
        message: "Account confirmed successfully.",
        severity: "success",
      });
      setIsConfirmingSignUp(false);
      // Auto login after confirmation
      const user = await signIn({ username: email, password });
      if (user.isSignedIn) {
        window.location.reload();
      }
    } catch (err) {
      setSnackbar({
        open: true,
        message: cleanErrorMessage((err as Error).message),
        severity: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    try {
      const output = await resetPassword({ username: email });
      const step = output.nextStep.resetPasswordStep;
      if (step === "CONFIRM_RESET_PASSWORD_WITH_CODE") {
        setSnackbar({
          open: true,
          message: "Check your email for the confirmation code.",
          severity: "success",
        });
        setStep("confirmReset");
      } else if (step === "DONE") {
        setSnackbar({
          open: true,
          message: "Password reset already completed.",
          severity: "success",
        });
        setIsReset(false);
        setStep("requestReset");
      }
    } catch (err) {
      // Mirror the success path for an unknown email so the reset flow does not
      // reveal whether an account exists for the address.
      if ((err as Error).name === "UserNotFoundException") {
        setSnackbar({
          open: true,
          message: "Check your email for the confirmation code.",
          severity: "success",
        });
        setStep("confirmReset");
        return;
      }
      setSnackbar({
        open: true,
        message: cleanErrorMessage((err as Error).message),
        severity: "error",
      });
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode,
        newPassword,
      });
      setSnackbar({
        open: true,
        message: "Password reset successfully.",
        severity: "success",
      });
      setIsReset(false);
      setStep("requestReset");
      setEmail("");
      setConfirmationCode("");
      setNewPassword("");
    } catch (err) {
      setSnackbar({
        open: true,
        message: cleanErrorMessage((err as Error).message),
        severity: "error",
      });
    }
  };

  const inputStyles = {
    transition: "all 0.3s ease",
    input: {
      WebkitBoxShadow: "0 0 0 1000px var(--background) inset",
      WebkitTextFillColor: "var(--text)",
    },
    "& .MuiOutlinedInput-notchedOutline": {
      borderColor: "var(--border)",
    },
    "&:hover .MuiOutlinedInput-notchedOutline": {
      borderColor: "var(--border)",
    },
    "& .MuiInputBase-root": {
      backgroundColor: "var(--background)",
      color: "var(--text)",
    },
    "& .MuiInputLabel-root": {
      color: "var(--text)",
    },
    "& .MuiInputLabel-asterisk": {
      color: "#f44336",
    },
  };

  const iconProps = {
    sx: { color: "var(--placeholder-text)", fontSize: 20 },
  };

  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        backgroundColor: "var(--background2)",
        transition: "background-color 0.3s ease",
      }}
    >
      <Snackbar
        open={snackbar.open}
        autoHideDuration={8000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          sx={{ width: "100%", maxWidth: 400, whiteSpace: "pre-line" }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "16px",
          transition: "all 0.3s ease",
          opacity: 0,
          animation: "fadeIn 0.6s forwards",
          minHeight: "100vh",
          backgroundColor: "var(--background2)",
        }}
      >
        <Box
          sx={{
            width: "100%",
            maxWidth: 420,
            animation: "slideUp 0.6s ease-out",
            border: "1px solid var(--border)",
            borderRadius: 2,
            padding: 2,
            backgroundColor: "var(--background)",
          }}
        >
          <Typography
            variant="h5"
            fontWeight={600}
            textAlign="left"
            mb={2}
            sx={{
              color: "var(--text)",
              fontFamily: "var(--font-family)",
              fontSize: 22,
              transition: "all 0.3s ease",
            }}
          >
            <div
              style={{
                opacity: 0,
                animation: "fadeIn 0.6s forwards",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <Gavel
                sx={{
                  fontSize: 40,
                  color: "var(--primary)",
                  backgroundColor: "var(--secondary)",
                  p: 1,
                  borderRadius: "50%",
                }}
              />
              {isReset
                ? "Reset Password"
                : isSignUp
                  ? "Create Account"
                  : "LAIGO"}
            </div>
          </Typography>

          {/* Conditional rendering of forms based on state */}
          <Box
            component="form"
            noValidate
            onSubmit={
              isReset && step === "confirmReset"
                ? handleConfirmReset
                : isConfirmingSignUp
                  ? handleConfirmSignUp
                  : handleSubmit
            }
          >
            {isConfirmingSignUp ? (
              <>
                <TextField
                  fullWidth
                  label="Confirmation Code"
                  margin="normal"
                  value={confirmationCode}
                  onChange={(e) => setConfirmationCode(e.target.value)}
                  sx={inputStyles}
                />
                <Button
                  type="submit"
                  fullWidth
                  variant="contained"
                  sx={{
                    mt: 2,
                    color: "white",
                    backgroundColor: "var(--primary)",
                    boxShadow: "none",
                    borderRadius: 2,
                    fontFamily: "var(--font-family)",
                    "&:hover": {
                      backgroundColor: "var(--secondary)",
                      boxShadow: "none",
                    },
                  }}
                >
                  {loading ? (
                    <CircularProgress size={24} color="inherit" />
                  ) : (
                    "Confirm Sign Up"
                  )}
                </Button>
                <Box mt={2} textAlign="center">
                  <Link
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      setIsConfirmingSignUp(false);
                    }}
                    underline="hover"
                    sx={{ fontSize: 14, color: "var(--primary)" }}
                  >
                    Back to Sign In
                  </Link>
                </Box>
              </>
            ) : (
              <>
                {isReset ? (
                  <>
                    <TextField
                      fullWidth
                      label="Email"
                      placeholder="example@ubc.ca"
                      type="email"
                      variant="outlined"
                      margin="normal"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <Email {...iconProps} />
                          </InputAdornment>
                        ),
                      }}
                      sx={inputStyles}
                    />
                    {step === "confirmReset" && (
                      <>
                        <TextField
                          fullWidth
                          label="Confirmation Code"
                          margin="normal"
                          value={confirmationCode}
                          onChange={(e) => setConfirmationCode(e.target.value)}
                          sx={inputStyles}
                        />
                        <TextField
                          fullWidth
                          label="New Password"
                          type="password"
                          margin="normal"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          sx={inputStyles}
                        />
                      </>
                    )}
                    {step === "requestReset" && (
                      <Button
                        fullWidth
                        onClick={handleReset}
                        variant="contained"
                        sx={{
                          mt: 2,
                          color: "white",
                          backgroundColor: "var(--primary)",
                          boxShadow: "none",
                          borderRadius: 2,
                          fontFamily: "var(--font-family)",
                          "&:hover": {
                            backgroundColor: "var(--secondary)",
                            boxShadow: "none",
                          },
                        }}
                      >
                        Send Reset Code
                      </Button>
                    )}
                    {step === "confirmReset" && (
                      <Button
                        type="submit"
                        fullWidth
                        variant="contained"
                        sx={{
                          mt: 2,
                          color: "white",
                          backgroundColor: "var(--primary)",
                          boxShadow: "none",
                          borderRadius: 2,
                          fontFamily: "var(--font-family)",
                          "&:hover": {
                            backgroundColor: "var(--secondary)",
                            boxShadow: "none",
                          },
                        }}
                      >
                        Confirm Reset
                      </Button>
                    )}
                    <Box mt={2} textAlign="center">
                      <Link
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setIsReset(false);
                        }}
                        underline="hover"
                        sx={{ fontSize: 14, color: "var(--primary)" }}
                      >
                        Back to Sign In
                      </Link>
                    </Box>
                  </>
                ) : (
                  <>
                    {isSignUp && (
                      <Box sx={{ display: "flex", gap: 2 }}>
                        <TextField
                          label="First Name"
                          variant="outlined"
                          margin="normal"
                          required
                          value={firstName}
                          onChange={(e) => {
                            setFirstName(e.target.value);
                            setSignUpErrors((prev) => ({
                              ...prev,
                              firstName: undefined,
                            }));
                          }}
                          error={!!signUpErrors.firstName}
                          helperText={signUpErrors.firstName}
                          sx={{ ...inputStyles, flex: 1 }}
                        />
                        <TextField
                          label="Last Name"
                          variant="outlined"
                          margin="normal"
                          required
                          value={lastName}
                          onChange={(e) => {
                            setLastName(e.target.value);
                            setSignUpErrors((prev) => ({
                              ...prev,
                              lastName: undefined,
                            }));
                          }}
                          error={!!signUpErrors.lastName}
                          helperText={signUpErrors.lastName}
                          sx={{ ...inputStyles, flex: 1 }}
                        />
                      </Box>
                    )}
                    <TextField
                      fullWidth
                      label="Email"
                      placeholder="example@ubc.ca"
                      type="email"
                      variant="outlined"
                      margin="normal"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (isSignUp) {
                          setSignUpErrors((prev) => ({
                            ...prev,
                            email: undefined,
                          }));
                        }
                      }}
                      error={isSignUp && !!signUpErrors.email}
                      helperText={isSignUp ? signUpErrors.email : undefined}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <Email {...iconProps} />
                          </InputAdornment>
                        ),
                      }}
                      sx={inputStyles}
                    />
                    <TextField
                      fullWidth
                      label="Password"
                      type={showPassword ? "text" : "password"}
                      variant="outlined"
                      margin="normal"
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (isSignUp) {
                          checkPasswordRequirements(e.target.value);
                          setSignUpErrors((prev) => ({
                            ...prev,
                            password: undefined,
                          }));
                        }
                      }}
                      error={isSignUp && !!signUpErrors.password}
                      helperText={isSignUp ? signUpErrors.password : undefined}
                      InputProps={{
                        startAdornment: (
                          <InputAdornment position="start">
                            <Lock {...iconProps} />
                          </InputAdornment>
                        ),
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton
                              onClick={() => setShowPassword(!showPassword)}
                              edge="end"
                              disableRipple
                              sx={{
                                p: 0.5,
                                border: "none",
                                outline: "none",
                                "&:focus": {
                                  outline: "none",
                                  boxShadow: "none",
                                },
                                "&:hover": {
                                  backgroundColor: "transparent",
                                },
                              }}
                            >
                              {showPassword ? (
                                <VisibilityOff {...iconProps} />
                              ) : (
                                <Visibility {...iconProps} />
                              )}
                            </IconButton>
                          </InputAdornment>
                        ),
                      }}
                      sx={inputStyles}
                    />
                    {isSignUp && password && (
                      <Box
                        sx={{
                          mt: 0.5,
                          mb: 0.5,
                          p: 0.8,
                          backgroundColor: "var(--background2)",
                          borderRadius: 1,
                          border: "1px solid var(--border)",
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: "var(--text)",
                            fontWeight: 600,
                            mb: 0.3,
                            display: "block",
                            fontFamily: "var(--font-family)",
                            fontSize: "0.65rem",
                          }}
                        >
                          Requirements:
                        </Typography>
                        <Box
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 0.5,
                          }}
                        >
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Box
                              sx={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor: passwordRequirements.minLength
                                  ? "#4caf50"
                                  : "var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {passwordRequirements.minLength && (
                                <Typography
                                  sx={{ color: "white", fontSize: 8 }}
                                >
                                  ✓
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{
                                color: passwordRequirements.minLength
                                  ? "#4caf50"
                                  : "var(--placeholder-text)",
                                fontFamily: "var(--font-family)",
                                fontSize: "0.65rem",
                              }}
                            >
                              At least 12 characters
                            </Typography>
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Box
                              sx={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor:
                                  passwordRequirements.hasLowercase
                                    ? "#4caf50"
                                    : "var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {passwordRequirements.hasLowercase && (
                                <Typography
                                  sx={{ color: "white", fontSize: 8 }}
                                >
                                  ✓
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{
                                color: passwordRequirements.hasLowercase
                                  ? "#4caf50"
                                  : "var(--placeholder-text)",
                                fontFamily: "var(--font-family)",
                                fontSize: "0.65rem",
                              }}
                            >
                              One lowercase letter
                            </Typography>
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Box
                              sx={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor:
                                  passwordRequirements.hasUppercase
                                    ? "#4caf50"
                                    : "var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {passwordRequirements.hasUppercase && (
                                <Typography
                                  sx={{ color: "white", fontSize: 8 }}
                                >
                                  ✓
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{
                                color: passwordRequirements.hasUppercase
                                  ? "#4caf50"
                                  : "var(--placeholder-text)",
                                fontFamily: "var(--font-family)",
                                fontSize: "0.65rem",
                              }}
                            >
                              One uppercase letter
                            </Typography>
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Box
                              sx={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor: passwordRequirements.hasNumber
                                  ? "#4caf50"
                                  : "var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {passwordRequirements.hasNumber && (
                                <Typography
                                  sx={{ color: "white", fontSize: 8 }}
                                >
                                  ✓
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{
                                color: passwordRequirements.hasNumber
                                  ? "#4caf50"
                                  : "var(--placeholder-text)",
                                fontFamily: "var(--font-family)",
                                fontSize: "0.65rem",
                              }}
                            >
                              One number
                            </Typography>
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                              gridColumn: "span 2",
                            }}
                          >
                            <Box
                              sx={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                backgroundColor:
                                  passwordRequirements.hasSpecialChar
                                    ? "#4caf50"
                                    : "var(--border)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {passwordRequirements.hasSpecialChar && (
                                <Typography
                                  sx={{ color: "white", fontSize: 8 }}
                                >
                                  ✓
                                </Typography>
                              )}
                            </Box>
                            <Typography
                              variant="caption"
                              sx={{
                                color: passwordRequirements.hasSpecialChar
                                  ? "#4caf50"
                                  : "var(--placeholder-text)",
                                fontFamily: "var(--font-family)",
                                fontSize: "0.65rem",
                              }}
                            >
                              One special character
                            </Typography>
                          </Box>
                        </Box>
                      </Box>
                    )}
                    {isSignUp && (
                      <TextField
                        fullWidth
                        label="Confirm Password"
                        type={showConfirmPassword ? "text" : "password"}
                        variant="outlined"
                        margin="normal"
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => {
                          setConfirmPassword(e.target.value);
                          if (password)
                            checkPasswordRequirements(password, e.target.value);
                          setSignUpErrors((prev) => ({
                            ...prev,
                            confirmPassword: undefined,
                          }));
                        }}
                        error={!!signUpErrors.confirmPassword}
                        helperText={signUpErrors.confirmPassword}
                        InputProps={{
                          startAdornment: (
                            <InputAdornment position="start">
                              <Lock {...iconProps} />
                            </InputAdornment>
                          ),
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                onClick={() =>
                                  setShowConfirmPassword(!showConfirmPassword)
                                }
                                edge="end"
                                disableRipple
                                sx={{
                                  p: 0.5,
                                  border: "none",
                                  outline: "none",
                                  "&:focus": {
                                    outline: "none",
                                    boxShadow: "none",
                                  },
                                  "&:hover": {
                                    backgroundColor: "transparent",
                                  },
                                }}
                              >
                                {showConfirmPassword ? (
                                  <VisibilityOff {...iconProps} />
                                ) : (
                                  <Visibility {...iconProps} />
                                )}
                              </IconButton>
                            </InputAdornment>
                          ),
                        }}
                        sx={inputStyles}
                      />
                    )}
                    {isSignUp && confirmPassword && (
                      <Box
                        sx={{
                          mt: 0.5,
                          display: "flex",
                          alignItems: "center",
                          gap: 0.5,
                        }}
                      >
                        <Box
                          sx={{
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            backgroundColor: passwordRequirements.passwordsMatch
                              ? "#4caf50"
                              : "#f44336",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {passwordRequirements.passwordsMatch ? (
                            <Typography sx={{ color: "white", fontSize: 10 }}>
                              ✓
                            </Typography>
                          ) : (
                            <Typography sx={{ color: "white", fontSize: 10 }}>
                              ✗
                            </Typography>
                          )}
                        </Box>
                        <Typography
                          variant="caption"
                          sx={{
                            color: passwordRequirements.passwordsMatch
                              ? "#4caf50"
                              : "#f44336",
                            fontFamily: "var(--font-family)",
                          }}
                        >
                          {passwordRequirements.passwordsMatch
                            ? "Passwords match"
                            : "Passwords do not match"}
                        </Typography>
                      </Box>
                    )}
                    {!isSignUp && (
                      <Box textAlign="right" mt={1}>
                        <Link
                          href="#"
                          underline="hover"
                          onClick={(e) => {
                            e.preventDefault();
                            setIsReset(true);
                          }}
                          sx={{ fontSize: 13, color: "var(--primary)" }}
                        >
                          Forgot password?
                        </Link>
                      </Box>
                    )}
                    <Button
                      type="submit"
                      fullWidth
                      variant="contained"
                      sx={{
                        mt: 2,
                        color: "white",
                        backgroundColor: "var(--primary)",
                        boxShadow: "none",
                        borderRadius: 2,
                        fontFamily: "var(--font-family)",
                        "&:hover": {
                          backgroundColor: "var(--secondary)",
                          boxShadow: "none",
                        },
                      }}
                      disabled={loading}
                    >
                      {loading ? (
                        <CircularProgress size={24} color="inherit" />
                      ) : isSignUp ? (
                        "Sign Up"
                      ) : (
                        "Sign In"
                      )}
                    </Button>
                    <Box textAlign="center" mt={2}>
                      <Link
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setIsSignUp((prev) => !prev);
                          setSignUpErrors({});
                        }}
                        underline="hover"
                        sx={{ fontSize: 14, color: "var(--primary)" }}
                      >
                        {isSignUp
                          ? "Already have an account? Sign In"
                          : "Don't have an account? Sign Up"}
                      </Link>
                    </Box>
                  </>
                )}
              </>
            )}
          </Box>
        </Box>
      </div>
    </div>
  );
};

export default Login;
