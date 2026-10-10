// Local browser-test entry only. The production entry remains Clerk-protected.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentImport } from "../../src/components/conferences/document-import";
import "../../src/index.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <main className="mx-auto max-w-4xl p-5">
      <h1 className="mb-4 font-serif text-3xl">Synthetic conference 2090</h1>
      <DocumentImport
        eventId={
          new URLSearchParams(location.search).get("eventId") ||
          "synthetic-event"
        }
        onComplete={() => undefined}
      />
    </main>
  </QueryClientProvider>,
);
