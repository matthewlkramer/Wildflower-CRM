// Synthetic fixture identity only; this module is aliased solely by feedback-vite.config.ts.
export const useClerk = () => ({ signOut: async () => undefined });
export const useUser = () => ({
  user: {
    id: "synthetic-clerk",
    firstName: "Synthetic",
    fullName: "Synthetic Tester",
    imageUrl: "",
  },
});
export const useAuth = () => ({ getToken: async () => null, isSignedIn: true });
export const ClerkProvider = ({
  children,
}: {
  children: import("react").ReactNode;
}) => children;
export const Show = ({ children }: { children: import("react").ReactNode }) =>
  children;
export const SignIn = () => null;
export const SignUp = () => null;
