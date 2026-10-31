import { cookies } from "next/headers";
import { Home } from "@/components/home";

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [jar, query] = await Promise.all([cookies(), searchParams]);
  const layout = jar.get("igor-layout")?.value;
  const requestedView = Array.isArray(query.view) ? query.view[0] : query.view;
  const initialExploreView =
    requestedView === "compare" || requestedView === "detail" ||
    requestedView === "plan" || requestedView === "revisions" ||
    requestedView === "maps" ? requestedView : "discover";
  const initialPage =
    requestedView === "saved" ? "saved" as const :
    requestedView === "conversations" ? "history" as const :
    requestedView === "home" ? "home" as const :
    requestedView === "create" ? "create" as const :
    requestedView === "maps" ? "maps" as const :
    requestedView === "explore" || requestedView === "compare" ||
    requestedView === "detail" || requestedView === "plan" ||
    requestedView === "revisions" ? "explore" as const : "work" as const;

  return (
    <Home
      initialExploreView={initialExploreView}
      initialPage={initialPage}
      initialConversation={!!query.task || layout?.startsWith("conversation:")}
      initialPane={requestedView === "editor" ? "work" : "thread"}
      initialHasResult={layout === "conversation:result"}
    />
  );
}
