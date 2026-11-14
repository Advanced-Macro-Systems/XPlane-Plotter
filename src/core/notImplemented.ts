/** Placeholder used by contract stubs while a module is being written. Remove every use before shipping. */
export function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`${name} is not implemented yet (${args.length} args)`)
}
