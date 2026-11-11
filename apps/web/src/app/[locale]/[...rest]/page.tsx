import { notFound } from "next/navigation";

// KTD12: anything under a valid locale that no route matches is a localized
// 404, rendered by the [locale] layout (same <html lang>).
export default function CatchAllPage() {
  notFound();
}
