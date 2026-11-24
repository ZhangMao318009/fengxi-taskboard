import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FengxiExecutionPanel } from './FengxiExecutionPanel';
import { fengxiReturn, fengxiReady } from '../api';
import type { Task } from '../types';

vi.mock('../i18n', () => ({useTaskboardI18n: () => ({text: (zh: string) => zh})}));
vi.mock('./MarkdownDocument', () => ({MarkdownDocument: ({value}: {value: string}) => <div>{value}</div>}));
vi.mock('../api', () => ({
  ApiError: class extends Error {}, fengxiReturn: vi.fn(), fengxiReady: vi.fn(),
  fengxiAccept: vi.fn(), fengxiPause: vi.fn(), fengxiReview: vi.fn(), fengxiSourceResearch:vi.fn(), moveTask: vi.fn(),
  getFengxiStatus: vi.fn(async () => ({bindings: []})),
  listComments: vi.fn(async () => []),
}));

function card(status = 'technical_review_pass'): Task {
  return {id:'card', projectId:'project', version:4, status:'in_review',
    fengxi: {bound:true, requirementRevision:1, route:'direct', attempts:[], pendingChanges:false,
      approval:{executionMode:'managed',entry:'official-d',allowedPaths:['/approved'],acceptanceCriteria:'Verify result'},
      attempt:{id:'attempt',status,evidenceHash:'hash',payload:{executionMode:'managed'}},
    }} as unknown as Task;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test('unreviewed delivery never says technical review passed', async () => {
  render(<FengxiExecutionPanel task={card('returned')} onTask={vi.fn()} onError={vi.fn()} />);
  expect(screen.getByText('执行已返回，尚未技术审核。')).toBeTruthy();
  expect(screen.queryByText(/技术审查已通过/)).toBeNull();
});

test('explicit rework approves the new revision using the original scope once', async () => {
  const task=card();
  const returned={...task,version:5,status:'todo',fengxi:{...task.fengxi!,requirementRevision:2,approval:null}} as Task;
  vi.mocked(fengxiReturn).mockResolvedValue(returned);
  vi.mocked(fengxiReady).mockResolvedValue({...returned,version:6});
  render(<FengxiExecutionPanel task={task} onTask={vi.fn()} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('说明'),{target:{value:'Fix the output'}});
  fireEvent.click(screen.getByRole('button',{name:'按此意见返工并执行'}));
  await waitFor(() => expect(fengxiReady).toHaveBeenCalledTimes(1));
  expect(fengxiReady).toHaveBeenCalledWith('card',expect.objectContaining({ifVersion:5,
    allowedPaths:['/approved'],entry:'official-d',executionMode:'managed',note:'Fix the output'}));
});

test('rework requested during execution is recorded without another approval', async () => {
  const task=card('running');
  vi.mocked(fengxiReturn).mockResolvedValue({...task,version:5});
  const onTask=vi.fn();
  render(<FengxiExecutionPanel task={task} onTask={onTask} onError={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('说明'),{target:{value:'After current work'}});
  fireEvent.click(screen.getByRole('button',{name:'记录返工意见'}));
  await waitFor(() => expect(onTask).toHaveBeenCalled());
  expect(fengxiReady).not.toHaveBeenCalled();
});
