/**
 * What the note's title bar starts with when the main window's sidebar is a rail (PEN-135 item
 * 6): Back and Forward and, in the Mac app, Keep on Top's pin, which the sidebar's head holds
 * while it is open. NotesShell provides them while the rail and a note show; a note window has
 * its own (T45, T46) and none of these.
 */
import { createContext, type ReactNode } from 'react';

export const TitleBarLead = createContext<ReactNode>(null);
