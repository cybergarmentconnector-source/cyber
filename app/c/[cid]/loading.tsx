/**
 * Shown the instant this page is opened, until its code arrives from the server: the page's own shape
 * (title, period, placeholders), inside the app frame. See components/shell.tsx → RouteSkeleton.
 */
import { RouteSkeleton } from '@/components/shell';
export default function Loading() { return <RouteSkeleton />; }
