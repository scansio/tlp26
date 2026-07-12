import { SignIn } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <SignIn
        appearance={{
          baseTheme: dark,
          elements: {
            card: "bg-card border border-border shadow-lg",
            headerTitle: "text-foreground",
            headerSubtitle: "text-muted-foreground",
            socialButtonsBlockButton: "border border-border bg-card text-foreground hover:bg-accent",
            formFieldLabel: "text-foreground",
            formFieldInput: "bg-background border-border text-foreground",
            footerActionLink: "text-primary hover:text-primary/80",
          },
        }}
      />
    </main>
  );
}
