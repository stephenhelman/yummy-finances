"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Only pages that exist today. Rules, Review and Reports are added when those steps ship.
const ITEMS = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/connections", label: "Connections", exact: false },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => {
        const current = i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={current ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
