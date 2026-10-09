// Auth user shape (the tailnet login the API reports for this browser).
// Domain/data types live in src/data/types.ts.
export interface User {
  id: string
  email: string
  displayName?: string
  photoURL?: string
}
