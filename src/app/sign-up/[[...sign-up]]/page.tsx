import { SignUp } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-8 sm:px-6 md:p-8">
      <div className="w-full max-w-md min-w-0">
        <SignUp
          appearance={{
            baseTheme: dark,
            elements: {
              rootBox: "w-full",
              card: "w-full bg-card border border-border shadow-lg",
              headerTitle: "text-foreground text-xl md:text-2xl",
              headerSubtitle: "text-muted-foreground",
              socialButtonsBlockButton:
                "min-h-11 border border-border bg-card text-foreground hover:bg-accent",
              formFieldLabel: "text-foreground",
              formFieldInput: "min-h-11 bg-background border-border text-foreground",
              formButtonPrimary: "min-h-11",
              footerActionLink: "text-primary hover:text-primary/80",
            },
          }}
        />
      </div>
    </main>
  );
}
