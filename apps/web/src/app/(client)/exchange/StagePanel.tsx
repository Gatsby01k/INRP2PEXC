import type { ReactNode } from 'react';
import type { RobotMood } from '../../(public)/_landing/robot/cues.ts';
import type { Step } from '../_assistant/model.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import shell from '../shell.module.css';
import stage from './stage.module.css';

/**
 * The Exchange's stage before there is a quote to put on it: the mark's orange, the robot in its halo, and one
 * sentence about what is happening — ready for a request, or a request being priced. It is the same stage the firm
 * quote then takes (`QuoteCard`), so the page keeps its shape from the first amount typed to the decision.
 *
 * `steps` is the request's own sequence, drawn as a line of stops along the foot of the stage.
 */
export function StagePanel({
  mood,
  chip,
  refText,
  title,
  body,
  steps,
  children,
  live,
}: {
  mood: RobotMood;
  chip: ReactNode;
  refText?: string | undefined;
  title: string;
  body: ReactNode;
  steps?: readonly Pick<Step, 'label' | 'status' | 'detail'>[] | undefined;
  children?: ReactNode;
  /** The sentence changes as the desk works: announced politely when it does. */
  live?: boolean;
}) {
  return (
    <div className={`${shell.brandField} ${stage.stage}`} data-quiet="">
      <div className={stage.halo} aria-hidden="true">
        <i />
        <svg className={stage.haloArcs} viewBox="0 0 400 400" focusable="false">
          <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
          <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
          <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
        </svg>
        <svg className={stage.haloOrbit} viewBox="0 0 400 400" focusable="false">
          <circle cx="200" cy="200" r="194" />
          <circle className={stage.haloNode} cx="200" cy="6" r="6" />
          <circle className={stage.haloNode} cx="32" cy="297" r="5" />
          <circle className={stage.haloNode} cx="368" cy="297" r="5" />
        </svg>
      </div>
      <RobotFigure mood={mood} className={stage.robot} />

      <header className={stage.stageHead}>
        <span className={stage.chip}>{chip}</span>
        {refText ? <span className={stage.ref}>{refText}</span> : null}
      </header>

      <div className={stage.say} {...(live ? { role: 'status' } : {})}>
        <h2 className={stage.sayTitle}>{title}</h2>
        <p className={stage.sayBody}>{body}</p>
      </div>

      {children ? <div className={stage.sayActions}>{children}</div> : null}

      {steps && steps.length > 0 ? (
        <ol className={stage.steps}>
          {steps.map((s, i) => (
            <li key={s.label} data-status={s.status}>
              <span className={stage.stepDot} aria-hidden="true">
                {i + 1}
              </span>
              <span className={stage.stepText}>
                <span className={stage.stepLabel}>{s.label}</span>
                {s.detail ? <span className={stage.stepDetail}>{s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
