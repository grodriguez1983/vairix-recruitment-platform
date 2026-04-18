/**
 * Tailwind class combinator: `clsx` for conditional classes, then
 * `tailwind-merge` to deduplicate conflicting utilities.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
