"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/review", label: "Review", exact: false, badge: true },
  { href: "/admin/transactions", label: "Transactions", exact: false },
  { href: "/admin/rules", label: "Rules", exact: false },
  { href: "/admin/connections", label: "Connections", exact: false },
] as const;

/** `reviewCount` is null when categorization hasn't run yet (no badge). */
export function AdminNav({ reviewCount }: { reviewCount: number | null }) {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);
  // On a phone the nav scrolls sideways: keep the current page's tab in view.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [pathname]);
  return (
    <nav className="nav" aria-label="Main" ref={nav}>
      {ITEMS.map((i) => {
        const current = i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link key={i.href} href={i.href} aria-current={current ? "page" : undefined}>
            {i.label}
            {"badge" in i && reviewCount ? <span className="nav-badge num" aria-label={`${reviewCount} to review`}>{reviewCount > 99 ? "99+" : reviewCount}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
