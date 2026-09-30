// The error answers of the bundle's endpoints: Directus's own body shape,
// one error with its code in `extensions`, and the one way a rejected
// async handler reaches the Directus error handler.

export const errorBody = (code: string, message: string) => ({
  errors: [{ extensions: { code }, message }],
});

// Express 4 does not forward rejected async handlers, so every failure
// reaches the Directus error handler through next(error) explicitly.
export const forwardError = (
  next: (error: unknown) => void,
  error: unknown,
): void => {
  next(error);
};
