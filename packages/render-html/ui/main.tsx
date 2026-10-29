import { render } from 'preact';
import type { ReviewPlan } from '@bowi/core/types';
import { App } from './App.tsx';
import './styles.css';

const data = document.getElementById('bowi-plan')?.textContent ?? 'null';
const plan = JSON.parse(data) as ReviewPlan | string;
const root = document.getElementById('app')!;

if (typeof plan === 'string') {
  root.textContent =
    'This is the Bowi page template without a review plan. Generate a report with `bowi`.';
} else {
  render(<App plan={plan} />, root);
}
