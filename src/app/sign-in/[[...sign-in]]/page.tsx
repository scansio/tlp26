import { SignIn } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center overflow-x-hidden bg-background px-4 py-8 md:px-6">
      <SignIn
        appearance={{
          baseTheme: dark,
          elements: {
            rootBox: "w-full max-w-md mx-auto",
            card: "w-full bg-card border border-border shadow-lg p-5 sm:p-8",
            headerTitle: "text-foreground text-xl md:text-2xl",
            headerSubtitle: "text-muted-foreground",
            socialButtonsBlockButton: "min-h-11 border border-border bg-card text-foreground hover:bg-accent",
            formFieldLabel: "text-foreground",
            formFieldInput: "min-h-11 bg-background border-border text-foreground",
            formButtonPrimary: "min-h-11",
            footerActionLink: "text-primary hover:text-primary/80",
          },
        }}
      />
    </main>
  );
}
