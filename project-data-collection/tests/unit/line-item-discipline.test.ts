import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canPickDiscipline, disciplineChoices, isFaaEmail } from '../../lib/line-item-discipline.ts'
import type { ProjectPermissions } from '../../lib/project-role.ts'
import type { Project, SafeUser } from '../../lib/types.ts'

const perms = (p: Partial<ProjectPermissions>): ProjectPermissions => ({
  role: null, loading: false, isAdmin: false, canEdit: false, canContribute: false, isViewer: false, ...p,
})
const user = (email: string) => ({ email, name: '', role: 'consultant' }) as SafeUser

test('admins and @faainc.com contributors may pick a discipline', () => {
  assert.equal(canPickDiscipline(user('a@x.com'), perms({ isAdmin: true, canContribute: true })), true)
  assert.equal(canPickDiscipline(user('Megan@FAAinc.com '), perms({ canContribute: true })), true)
  assert.equal(canPickDiscipline(user('m@atlasmech.com'), perms({ canContribute: true, canEdit: true })), false)
})

test('a viewer never picks, whatever the email', () => {
  assert.equal(canPickDiscipline(user('m@faainc.com'), perms({ isViewer: true })), false)
})

test('isFaaEmail matches the domain only', () => {
  assert.equal(isFaaEmail('x@faainc.com'), true)
  assert.equal(isFaaEmail('x@notfaainc.com'), false)
  assert.equal(isFaaEmail('x@faainc.com.evil.io'), false)
})

test('choices: the default first, then the roster, each once', () => {
  const project = {
    consultants: [
      { type: 'Mechanical', orgName: '', emails: [] },
      { type: 'architecture', orgName: '', emails: [] },
      { type: 'Civil', orgName: '', emails: [] },
    ],
  } as unknown as Project
  assert.deepEqual(disciplineChoices(project, 'Architecture'), ['Architecture', 'Mechanical', 'Civil'])
})
