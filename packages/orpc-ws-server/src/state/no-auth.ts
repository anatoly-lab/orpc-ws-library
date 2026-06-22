// The "absent user" type for AUTHLESS mode.
//
// WHY this exists: an authless server accepts every upgrade and hands an
// EMPTY context (`{}`) to ORPC — there is no authenticated principal. We
// could model "no user" as `undefined` or `unknown`, but both leak into
// the typed surface as usable-looking values (a consumer's hook could
// read `user.sub` off `undefined` and crash, or `unknown` would force
// noisy casts everywhere). Instead we use a BRANDED, structurally-
// uninhabited type: a value of `NoAuth` cannot be produced (the brand
// key is a `unique symbol` typed `never`), so the type system actively
// rejects any attempt to read a user in authless code — without `any`
// and without `undefined` noise.
//
// CLAUDE.md "No `any`" + "end-to-end typing" — this keeps the authless
// path honest: the absence of a user is a compile-time fact, not a
// runtime surprise.

declare const noAuthBrand: unique symbol;

/**
 * A structurally-uninhabited "there is no authenticated user" type.
 *
 * No value of this type can ever be constructed (the brand field is
 * `never`), so reaching for a `.user` in authless code is a type error
 * rather than a silent `undefined`.
 */
export type NoAuth = { readonly [noAuthBrand]: never };

/**
 * Compile-time predicate: `true` when `T` is exactly `NoAuth`. Wrapped in
 * single-element tuples to defeat distributive conditional types (so a
 * union `TUser` is compared as a whole, not member-by-member).
 *
 * Used by the factories to discriminate the authed vs authless option
 * shapes without a runtime flag in the public types.
 */
export type IsNoAuth<T> = [T] extends [NoAuth] ? true : false;
