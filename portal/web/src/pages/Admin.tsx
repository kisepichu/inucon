import { useCallback, useEffect, useState } from "react"
import type { Contest, Instance, InviteResult, TeamId, TeamInvite, TeamWithMembers } from "shared/schemas"
import { ApiError, api } from "../api.ts"

const formatDate = (millis: number) => new Date(millis).toLocaleString()

export function Admin() {
  const [teams, setTeams] = useState<Array<TeamWithMembers>>([])
  const [instancesByTeam, setInstancesByTeam] = useState<Record<string, Array<Instance>>>({})
  const [contest, setContest] = useState<Contest | null>(null)

  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [teamName, setTeamName] = useState("")
  const [teamNumber, setTeamNumber] = useState("")

  const [memberTeamId, setMemberTeamId] = useState("")
  const [memberLogins, setMemberLogins] = useState("")

  const [instanceTeamId, setInstanceTeamId] = useState("")
  const [instanceIndex, setInstanceIndex] = useState("")
  const [instancePrivateIp, setInstancePrivateIp] = useState("")

  // 招待(チーム選択 + githubLogin/email フォーム、Phase 3)。
  const [inviteTeamId, setInviteTeamId] = useState("")
  const [inviteLogin, setInviteLogin] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteSubmitting, setInviteSubmitting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [invites, setInvites] = useState<Array<TeamInvite>>([])

  const loadTeams = useCallback(async () => {
    const data = await api.listTeams()
    setTeams(data)
    const entries = await Promise.all(
      data.map(async (team) => [team.id, await api.listTeamInstances(team.id)] as const)
    )
    setInstancesByTeam(Object.fromEntries(entries))
  }, [])

  const loadContest = useCallback(async () => {
    try {
      setContest(await api.getContest())
    } catch {
      setContest(null)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        await loadTeams()
      } catch (err) {
        setError(err instanceof ApiError ? err.tag : "チーム一覧の読み込みに失敗しました")
      }
    })()
    loadContest()
  }, [loadTeams, loadContest])

  const loadInvites = useCallback(async (teamId: string, isCanceled: () => boolean) => {
    if (teamId === "") {
      if (!isCanceled()) {
        setInvites([])
      }
      return
    }
    try {
      const data = await api.listInvites(teamId)
      if (!isCanceled()) {
        setInvites(data)
      }
    } catch {
      if (!isCanceled()) {
        setInvites([])
      }
    }
  }, [])

  // 招待対象チームを切り替えたら招待中一覧を取り直す。切り替えを連打した場合に
  // 古いチームのレスポンスが後から届いて表示を上書きしないよう、キャンセルフラグで
  // 現在選択中のチーム以外の結果を破棄する(App.tsx/Team.tsx と同じパターン)。
  useEffect(() => {
    let canceled = false
    loadInvites(inviteTeamId, () => canceled)
    return () => {
      canceled = true
    }
  }, [inviteTeamId, loadInvites])

  const runAction = async (fn: () => Promise<void>) => {
    setError(null)
    setMessage(null)
    try {
      await fn()
      setMessage("OK")
    } catch (err) {
      setError(err instanceof ApiError ? err.tag : "操作に失敗しました")
    }
  }

  const handleCreateTeam = (event: React.FormEvent) => {
    event.preventDefault()
    runAction(async () => {
      await api.createTeam({ name: teamName, teamNumber: Number(teamNumber) })
      setTeamName("")
      setTeamNumber("")
      await loadTeams()
    })
  }

  const handleSetMembers = (event: React.FormEvent) => {
    event.preventDefault()
    runAction(async () => {
      const githubLogins = memberLogins
        .split(",")
        .map((login) => login.trim())
        .filter((login) => login !== "")
      await api.setTeamMembers(memberTeamId, { githubLogins })
      setMemberLogins("")
      await loadTeams()
    })
  }

  const handleCreateInstance = (event: React.FormEvent) => {
    event.preventDefault()
    runAction(async () => {
      await api.createInstance({
        // select の value は plain string(ブランド無し)なので、契約の
        // TeamId にキャストする(フロントエンドはランタイム検証をしない方針)。
        teamId: instanceTeamId as TeamId,
        index: Number(instanceIndex),
        privateIp: instancePrivateIp
      })
      setInstanceIndex("")
      setInstancePrivateIp("")
      await loadTeams()
    })
  }

  const handleDeleteInstance = (id: string) => {
    runAction(async () => {
      await api.deleteInstance(id)
      await loadTeams()
    })
  }

  const handleStartContest = () => runAction(async () => setContest(await api.startContest()))
  const handleFinishContest = () => runAction(async () => setContest(await api.finishContest()))

  const handleInvite = (event: React.FormEvent) => {
    event.preventDefault()
    setInviteError(null)
    setInviteResult(null)
    setInviteSubmitting(true)
    ;(async () => {
      try {
        const result = await api.inviteMember(inviteTeamId, { githubLogin: inviteLogin, email: inviteEmail })
        setInviteResult(result)
        setInviteLogin("")
        setInviteEmail("")
        await loadInvites(inviteTeamId, () => false)
      } catch (err) {
        setInviteError(err instanceof ApiError ? err.tag : "招待に失敗しました")
      } finally {
        setInviteSubmitting(false)
      }
    })()
  }

  return (
    <div>
      <h1>Admin</h1>
      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message !== null && <p className="notice-ok">{message}</p>}

      <section className="admin-section">
        <h2>コンテスト</h2>
        <p style={{ margin: "0 0 12px", fontSize: 13 }}>
          状態:{" "}
          {contest === null ? "未作成" : <span className={`status-badge status-${contest.status}`}>{contest.status}</span>}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleStartContest}
            disabled={contest === null || contest.status !== "preparing"}
          >
            開始
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleFinishContest}
            disabled={contest === null || contest.status !== "running"}
          >
            終了
          </button>
        </div>
      </section>

      <section className="admin-section">
        <h2>チーム作成</h2>
        <form className="form" onSubmit={handleCreateTeam}>
          <div className="form-field">
            <label htmlFor="admin-team-name">チーム名</label>
            <input
              id="admin-team-name"
              placeholder="チーム名"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="admin-team-number">チーム番号(1-254)</label>
            <input
              id="admin-team-number"
              placeholder="チーム番号(1-254)"
              value={teamNumber}
              onChange={(event) => setTeamNumber(event.target.value)}
              required
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary">
              作成
            </button>
          </div>
        </form>
      </section>

      <section className="admin-section">
        <h2>メンバー割当</h2>
        <form className="form" onSubmit={handleSetMembers}>
          <div className="form-field">
            <label htmlFor="admin-member-team">チームを選択</label>
            <select id="admin-member-team" value={memberTeamId} onChange={(event) => setMemberTeamId(event.target.value)} required>
              <option value="" disabled>
                チームを選択
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="admin-member-logins">githubLogin</label>
            <input
              id="admin-member-logins"
              placeholder="githubLogin をカンマ区切りで入力"
              value={memberLogins}
              onChange={(event) => setMemberLogins(event.target.value)}
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary">
              割当
            </button>
            <p className="disabled-reason">既存のメンバー一覧を置き換えます</p>
          </div>
        </form>
      </section>

      <section className="admin-section">
        <h2>招待</h2>
        <div className="form">
          <div className="form-field">
            <label htmlFor="admin-invite-team">チームを選択</label>
            <select id="admin-invite-team" value={inviteTeamId} onChange={(event) => setInviteTeamId(event.target.value)}>
              <option value="" disabled>
                チームを選択
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <form className="form invite-form" style={{ marginTop: 12 }} onSubmit={handleInvite}>
          <div className="form-field">
            <label htmlFor="invite-github-login">githubLogin</label>
            <input
              id="invite-github-login"
              placeholder="githubLogin"
              value={inviteLogin}
              onChange={(event) => setInviteLogin(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="invite-email">email(Access ログイン用)</label>
            <input
              id="invite-email"
              type="email"
              placeholder="email(Access ログイン用)"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              required
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary" disabled={inviteSubmitting || inviteTeamId === ""}>
              招待
            </button>
          </div>
        </form>
        {inviteError !== null && (
          <p role="alert" className="error">
            {inviteError}
          </p>
        )}
        {inviteResult !== null && (
          <div className="invite-result">
            <p>ポータル: {inviteResult.portal === "assigned" ? "即時割当(既にログイン済み)" : "招待作成(未ログイン)"}</p>
            <p>Access: {inviteResult.access.ok ? "OK" : `失敗(${inviteResult.access.error ?? "-"})`}</p>
            <ul>
              {inviteResult.sshKeys.map((sshKey) => (
                <li key={sshKey.instance}>
                  {sshKey.instance}: {sshKey.ok ? "OK" : `失敗(${sshKey.error ?? "-"})`}
                </li>
              ))}
            </ul>
            {inviteResult.warnings.length > 0 && (
              <ul className="warnings">
                {inviteResult.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <h3 style={{ marginTop: 24 }}>招待中一覧</h3>
        <div className="table-wrap" style={{ maxWidth: 640 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>githubLogin</th>
                <th>email</th>
                <th>招待日時</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.githubLogin}>
                  <td className="mono">{invite.githubLogin}</td>
                  <td className="mono">{invite.email}</td>
                  <td className="num">{formatDate(invite.invitedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section">
        <h2>インスタンス登録</h2>
        <form className="form" onSubmit={handleCreateInstance}>
          <div className="form-field">
            <label htmlFor="admin-instance-team">チームを選択</label>
            <select id="admin-instance-team" value={instanceTeamId} onChange={(event) => setInstanceTeamId(event.target.value)} required>
              <option value="" disabled>
                チームを選択
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="admin-instance-index">index</label>
            <input
              id="admin-instance-index"
              placeholder="index"
              value={instanceIndex}
              onChange={(event) => setInstanceIndex(event.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="admin-instance-private-ip">privateIp</label>
            <input
              id="admin-instance-private-ip"
              placeholder="privateIp"
              value={instancePrivateIp}
              onChange={(event) => setInstancePrivateIp(event.target.value)}
              required
            />
          </div>
          <div>
            <button type="submit" className="btn btn-primary">
              登録
            </button>
          </div>
        </form>
      </section>

      <section className="admin-section">
        <h2>チーム一覧</h2>
        {teams.map((team) => (
          <div className="team-block" key={team.id}>
            <h3>
              {team.name} (#{team.teamNumber})
            </h3>
            <p className="members">メンバー: {team.members.map((member) => member.githubLogin).join(", ") || "-"}</p>
            <ul>
              {(instancesByTeam[team.id] ?? []).map((instance) => (
                <li key={instance.id}>
                  <span className="mono">
                    inucon-team{team.teamNumber}-{instance.index} ({instance.privateIp})
                  </span>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDeleteInstance(instance.id)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}
