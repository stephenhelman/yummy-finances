import { redirect } from "next/navigation";

// The app lives under /admin (which sends signed-out visitors to /login).
export default function Home() {
  redirect("/admin");
}
