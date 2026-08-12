/**
 * The glyph each AI scope wears.
 *
 * Both halves of the AI tab offer the same three scopes, and `GlassPopupButton`
 * expects an icon that follows the *value* — a static one would say what the
 * control is rather than which scope is on. `Files` is the sidebar's glyph for
 * "All notes", so widening points at the row it widens to.
 *
 * Its own module rather than an export from `AskPanel`: a file that exports
 * both a component and a constant loses fast refresh.
 */
import { FileText, Files, GraduationCap, type LucideIcon } from 'lucide-react';
import type { AskScope } from '@/lib/ai';

export const SCOPE_ICONS: Record<AskScope, LucideIcon> = {
  note: FileText,
  course: GraduationCap,
  library: Files,
};
