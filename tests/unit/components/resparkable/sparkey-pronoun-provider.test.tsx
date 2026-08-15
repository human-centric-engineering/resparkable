/**
 * SparkeyPronounProvider Tests
 *
 * @see components/resparkable/sparkey-pronoun-provider.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  SparkeyPronounProvider,
  useSparkeyPronoun,
  useSparkeyPronounValue,
} from '@/components/resparkable/sparkey-pronoun-provider';

function Probe() {
  const forms = useSparkeyPronoun();
  return <div data-testid="probe">{`${forms.subject}/${forms.object}/${forms.possessive}`}</div>;
}

function ValueProbe() {
  return <div data-testid="value-probe">{useSparkeyPronounValue()}</div>;
}

describe('useSparkeyPronoun', () => {
  it('defaults to "it" forms outside any provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('it/it/its');
  });

  it('reflects the pronoun passed to SparkeyPronounProvider', () => {
    render(
      <SparkeyPronounProvider pronoun="he">
        <Probe />
      </SparkeyPronounProvider>
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('he/him/his');
  });
});

describe('useSparkeyPronounValue', () => {
  it('defaults to "it" outside any provider', () => {
    render(<ValueProbe />);
    expect(screen.getByTestId('value-probe')).toHaveTextContent('it');
  });

  it('reflects the pronoun passed to SparkeyPronounProvider', () => {
    render(
      <SparkeyPronounProvider pronoun="she">
        <ValueProbe />
      </SparkeyPronounProvider>
    );
    expect(screen.getByTestId('value-probe')).toHaveTextContent('she');
  });
});
