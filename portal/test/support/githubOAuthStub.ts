import { Effect, Layer } from "effect"
import { GithubOAuthPort, OAuthFailed } from "../../src/application/ports.js"

export interface StubGithubUser {
  readonly githubId: number
  readonly githubLogin: string
  readonly displayName: string
}

// code → GitHub ユーザーの対応表で GithubOAuthPort をスタブする。
// 対応表にない code は OAuthFailed で失敗する。
export const makeGithubOAuthStub = (
  codes: Record<string, StubGithubUser> = {}
): Layer.Layer<GithubOAuthPort> =>
  Layer.succeed(GithubOAuthPort, {
    authorizeUrl: (state) => `https://github.test/login/oauth/authorize?state=${state}`,
    exchangeCodeForUser: (code) => {
      const user = codes[code]
      return user !== undefined
        ? Effect.succeed(user)
        : Effect.fail(new OAuthFailed({ cause: `unknown code: ${code}` }))
    }
  })
