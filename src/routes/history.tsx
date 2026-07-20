import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { HistorySection } from "@/components/history-section";
import { useHistory } from "@/lib/history";
import { useLocal } from "@/lib/store";
import { DEFAULT_USERNAME } from "@/config";

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

function HistoryPage() {
  const history = useHistory();
  const [username] = useLocal<string>("kaka.username.v1", DEFAULT_USERNAME);

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-5 py-8 max-md:py-4">
      <Link
        to="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to today
      </Link>
      <HistorySection history={history} username={username} />
    </div>
  );
}
