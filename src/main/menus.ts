import { BrowserWindow, Menu, dialog, type MenuItemConstructorOptions } from 'electron'
import { log } from './log.ts'

/**
 * Native context menus rather than a React popover.
 *
 * A right-click menu is one of the few places where matching the OS exactly
 * matters more than matching our own design: it has to dismiss the way every
 * other menu on the machine dismisses, take the same keyboard handling, and
 * open on the correct side of the pointer near a screen edge. All of that is
 * free from Menu.popup and fiddly to reproduce.
 */
export interface MenuAt {
  /** Where the click happened, in window coordinates. */
  x: number
  y: number
}

// Menu.popup hands the native menu to the OS but the JavaScript object is what
// keeps it alive; letting it fall out of scope collects a menu that is still
// on screen. One live reference at a time is all a context menu needs.
let open: Menu | null = null

function pick(template: MenuItemConstructorOptions[], at: MenuAt): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return Promise.resolve(null)
  return new Promise((resolve) => {
    let chosen: string | null = null
    const wired = template.map((item) =>
      item.type === 'separator'
        ? item
        : {
            ...item,
            click: (): void => {
              chosen = String(item.id)
            }
          }
    )
    const menu = Menu.buildFromTemplate(wired)
    open = menu
    log.debug('menu', 'popup', { x: at.x, y: at.y, items: template.length })
    // Position explicitly. Without x and y, Electron opens at the OS cursor,
    // which is only the right place when a real pointer put it there -- and if
    // that cursor is outside the window the menu lands somewhere nobody can
    // see it, still open, waiting for a dismissal that never comes.
    //
    // The close callback can land before the click handler has run, so settle
    // on the next tick rather than reporting every pick as a dismissal.
    menu.popup({
      window: win,
      x: Math.round(at.x),
      y: Math.round(at.y),
      callback: () => {
        open = null
        log.debug('menu', 'closed', { chosen })
        setTimeout(() => resolve(chosen), 0)
      }
    })
  })
}

const REVEAL = process.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'

export function recordingMenu(
  input: { status: string; hasFiles: boolean } & MenuAt
): Promise<string | null> {
  return pick(
    [
      { id: 'open', label: 'Open' },
      { id: 'reveal', label: REVEAL, enabled: input.hasFiles },
      { type: 'separator' },
      ...(input.status === 'recording'
        ? [{ id: 'recover', label: 'Recover this recording' } as MenuItemConstructorOptions]
        : []),
      { id: 'rename', label: 'Rename…' },
      { type: 'separator' },
      { id: 'remove', label: 'Remove from Library' },
      { id: 'trash', label: 'Move to Trash…' }
    ],
    input
  )
}

export function projectMenu(at: MenuAt): Promise<string | null> {
  return pick(
    [
      { id: 'rename', label: 'Rename…' },
      { type: 'separator' },
      { id: 'delete', label: 'Delete Project…' }
    ],
    at
  )
}

/**
 * Trash is not the same promise as delete, and the wording says so -- people
 * agree to a destructive action far more readily when it is reversible, and
 * this one genuinely is.
 */
export async function confirmTrash(input: {
  title: string
  dir: string
  /** More than one selected: the wording counts them instead of naming one. */
  count?: number
}): Promise<boolean> {
  const many = (input.count ?? 1) > 1
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Move to Trash'],
    defaultId: 1,
    cancelId: 0,
    message: many
      ? `Move ${input.count} recordings to the Trash?`
      : `Move “${input.title}” to the Trash?`,
    detail: many
      ? 'Their footage, lanes and anything rendered from them go to the Trash. You can put them back from there.'
      : `The recording, its lanes and anything rendered from it go to the Trash:\n${input.dir}\n\nYou can put it back from there.`
  }
  const res = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return res.response === 1
}
