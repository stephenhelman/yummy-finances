import { redirect } from "next/navigation";

// Old address (bookmarks, earlier docs). The page now lives at /admin/connections.
export default function Moved() {
  redirect("/admin/connections");
}
