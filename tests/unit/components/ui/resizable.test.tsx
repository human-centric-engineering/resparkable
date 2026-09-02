// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';

describe('components/ui/resizable', () => {
  describe('rendering', () => {
    it('should render a panel group with its panels', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(container.querySelector('[data-panel-group]')).toBeInTheDocument();
      expect(container.querySelectorAll('[data-panel]')).toHaveLength(2);
    });

    it('should apply the flex-col class for vertical direction via data attribute', () => {
      const { container } = render(
        <ResizablePanelGroup direction="vertical">
          <ResizablePanel>Top</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Bottom</ResizablePanel>
        </ResizablePanelGroup>
      );

      const group = container.querySelector('[data-panel-group]');
      expect(group).toHaveAttribute('data-panel-group-direction', 'vertical');
    });

    it('should not render the grip icon when withHandle is omitted', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(container.querySelector('svg')).not.toBeInTheDocument();
    });

    it('should render the grip icon when withHandle is true', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('should render children passed into the handle', () => {
      const { getByTestId } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle>
            <button type="button" data-testid="collapse-toggle">
              Collapse
            </button>
          </ResizableHandle>
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(getByTestId('collapse-toggle')).toBeInTheDocument();
    });
  });

  describe('className prop', () => {
    it('should apply a custom className to the panel group alongside defaults', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal" className="custom-group">
          <ResizablePanel>Left</ResizablePanel>
        </ResizablePanelGroup>
      );

      const group = container.querySelector('[data-panel-group]');
      expect(group).toHaveClass('custom-group');
      expect(group).toHaveClass('flex');
      expect(group).toHaveClass('h-full');
      expect(group).toHaveClass('w-full');
    });

    it('should apply a custom className to the handle alongside defaults', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle className="custom-handle" />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      const handle = container.querySelector('[data-panel-resize-handle-id]');
      expect(handle).toHaveClass('custom-handle');
      expect(handle).toHaveClass('bg-border');
    });
  });

  describe('ref forwarding', () => {
    it('should forward a ref to the panel imperative handle', () => {
      const ref = createRef<React.ElementRef<typeof ResizablePanel>>();

      render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel ref={ref}>Left</ResizablePanel>
        </ResizablePanelGroup>
      );

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current?.collapse).toBe('function');
    });
  });

  describe('props spreading', () => {
    it('should spread additional props to the handle element', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle aria-label="Resize panels" />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      const handle = container.querySelector('[data-panel-resize-handle-id]');
      expect(handle).toHaveAttribute('aria-label', 'Resize panels');
    });
  });

  describe('accessibility', () => {
    it('should expose the handle as keyboard-focusable', () => {
      const { container } = render(
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel>Left</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>Right</ResizablePanel>
        </ResizablePanelGroup>
      );

      const handle = container.querySelector('[data-panel-resize-handle-id]');
      expect(handle).toHaveAttribute('tabindex', '0');
    });
  });
});
