import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Port of app/frontend/lib/utils.ts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
