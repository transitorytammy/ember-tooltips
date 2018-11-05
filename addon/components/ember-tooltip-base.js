/* global Tooltip */

import $ from 'jquery';
import Ember from 'ember';
import { computed } from '@ember/object';
import { assign } from '@ember/polyfills';
import { run } from '@ember/runloop';
import { warn } from '@ember/debug';
import Component from '@ember/component';
import RSVP from 'rsvp';
import config from 'ember-get-config';
import layout from '../templates/components/ember-tooltip-base';

const { environment } = config;

const ANIMATION_CLASS = 'ember-tooltip-show';
const POPPER_DEFAULT_MODIFIERS = {
  flip: {
    enabled: true,
  },
  preventOverflow: {
    escapeWithReference: true
  }
};

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.substring(1);
}

function getOppositeSide(placement) {
  if (!placement) {
    return null;
  }

  const [side] = placement.split('-');
  let oppositeSide;

  switch (side) {
    case 'top':
      oppositeSide = 'bottom';
      break;
    case 'right':
      oppositeSide = 'left';
      break;
    case 'bottom':
      oppositeSide = 'top';
      break;
    case 'left':
      oppositeSide = 'right';
      break;
  }

  return oppositeSide;
}

function cleanNumber(stringOrNumber) {
  let cleanNumber;

  if (stringOrNumber && typeof stringOrNumber === 'string') {
    cleanNumber = parseInt(stringOrNumber, 10);

    /* Remove invalid parseInt results */

    if (isNaN(cleanNumber) || !isFinite(cleanNumber)) {
      cleanNumber = 0;
    }
  } else {
    cleanNumber = stringOrNumber;
  }

  return cleanNumber;
}

export default Component.extend({
  classNames: ['ember-tooltip-base'],
  delay: 0,
  delayOnChange: true,
  duration: 0,
  effect: 'slide', // Options: fade, slide, none // TODO - make slide work
  event: 'hover', // Options: hover, click, focus, none
  tooltipClassName: 'ember-tooltip', /* Custom classes */
  isShown: false,
  text: null,
  side: 'top',
  spacing: 10,
  targetId: null,
  layout,
  updateFor: null,
  popperOptions: null,

  /* Actions */

  onDestroy: null,
  onHide: null,
  onRender: null,
  onShow: null,

  hideOn: computed('event', function() {
    const event  = this.get('event');

    let hideOn;

    switch (event) {
      case 'hover':
        hideOn = 'mouseleave';
        break;
      case 'focus':
        hideOn = 'blur';
        break;
      case 'ready':
        hideOn = null;
        break;
      default:
        hideOn = event;
        break;
    }

    return hideOn;
  }),

  showOn: computed('event', function() {
    const event  = this.get('event');

    let showOn;

    switch (event) {
      case 'hover':
        showOn = 'mouseenter';
        break;
      default:
        showOn = event;
        break;
    }

    return showOn;
  }),

  target: computed('targetId', function() {
    const targetId = this.get('targetId');

    let target;

    if (targetId) {
      target = document.getElementById(targetId);

      if (!target) {
        warn('No target found for targetId ', targetId, {
          id: 'ember-tooltips.no-element-with-targetId'
        });
      }
    } else {
      target = this.element.parentNode;
    }

    return target;
  }),

  /* An ID used to identify this tooltip from other tooltips */

  wormholeId: computed('elementId', function() {
    return `${this.get('elementId')}-wormhole`;
  }),

  _awaitingTooltipElementRendered: true,
  _tooltipEvents: null,
  _tooltip: null,
  _spacingRequestId: null,

  _animationDuration: computed(function() {
    const inTestingMode = environment === 'test' || Ember.testing;

    return inTestingMode ? 0 : 200;
  }),

  init() {
    this._super(...arguments);
    this.set('_tooltipEvents', []);
  },

  didInsertElement() {
    this._super(...arguments);

    this.createTooltip().then(() => {

    });
  },

  didUpdateAttrs() {
    this._super(...arguments);

    if (this.get('isShown')) {
      this.show();

      /* If updateFor exists, update the tooltip incase the changed Attr affected the tooltip content's height or width */

      if (this.get('updateFor') && this.get('_tooltip').popperInstance) {
        const popper = this.get('_tooltip').popperInstance;

        if (popper) {
          run.scheduleOnce('afterRender', popper, popper.update);
        }
      }
    } else {
      this.hide();
    }
  },

  willDestroyElement() {
    this._super(...arguments);

    const _tooltipEvents = this.get('_tooltipEvents');

    /* Remove event listeners used to show and hide the tooltip */

    _tooltipEvents.forEach((tooltipEvent) => {
      const {
        callback,
        target,
        eventName,
      } = tooltipEvent;

      target.removeEventListener(eventName, callback);
    });

    this._cleanupTimers();

    this.get('_tooltip').dispose();

    this._dispatchAction('onDestroy', this);
  },

  addTargetEventListeners() {
    this.addTooltipTargetEventListeners();
  },

  addTooltipBaseEventListeners() {

  },

  addTooltipTargetEventListeners() {

    /* Setup event handling to hide and show the tooltip */

    const event = this.get('event');

    /* Setup event handling to hide and show the tooltip */

    if (event === 'none') {
      return;
    }

    const hideOn = this.get('hideOn');
    const showOn = this.get('showOn');

    /* If show and hide are the same (e.g. click) toggle
    the visibility */

    if (showOn === hideOn) {
      this._addEventListener(showOn, () => {
        this.toggle();
      });
    } else {

      /* Else, add the show and hide events individually */

      if (showOn !== 'none') {
        this._addEventListener(showOn, () => {
          this.show();
        });
      }

      if (hideOn !== 'none') {
        this._addEventListener(hideOn, () => {
          this.hide();
        });
      }
    }

    /* Hide and show the tooltip on focus and escape
    for accessibility */

    if (event !== 'focus') {

      /* If the event is click, we don't want the
      click to also trigger focusin */

      if (event !== 'click') {
        this._addEventListener('focusin', () => {
          this.show();
        });
      }

      this._addEventListener('focusout', () => {
        this.hide();
      });
    }

    this._addEventListener('keydown', (keyEvent) => {

      keyEvent.stopImmediatePropagation(); /* So this callback only fires once per keydown */

      if (keyEvent.which === 27) {
        this.hide();

        keyEvent.preventDefault();

        return false;
      }
    }, document);
  },

  createTooltip() {
    return new RSVP.Promise((resolve, reject) => {

      try {
        run(() => {
          const rootElement = document.querySelector(config.APP.rootElement);
          const target = this.get('target');
          const tooltipClassName = this.get('tooltipClassName');

          const targetTitle = target.title;

          target.removeAttribute('title');

          const tooltip = new Tooltip(target, {
            container: rootElement || false,
            html: true,
            placement: this.get('side'),
            title: '<span></span>',
            trigger: 'manual',
            template: `<div class="tooltip ${tooltipClassName} ember-tooltip-effect-${this.get('effect')}" role="tooltip" style="margin:0;margin-${getOppositeSide(this.get('side'))}:${this.get('spacing')}px;">
                        <div class="tooltip-arrow ember-tooltip-arrow"></div>
                        <div class="tooltip-inner" id="${this.get('wormholeId')}"></div>
                       </div>`,

            popperOptions: {
              modifiers: mergeModifiers(
                POPPER_DEFAULT_MODIFIERS,
                this.get('popperOptions.modifiers')
              ),

              onCreate: (tooltipData) => {
                run(() => {

                  this._dispatchAction('onRender', this);

                  this.set('_awaitingTooltipElementRendered', false);

                  /* The tooltip element must exist in order to add event listeners to it */

                  this.addTooltipBaseEventListeners();

                  /* Once the wormhole has done it's work, we need the tooltip to be positioned again */

                  run.scheduleOnce('afterRender', () => {
                    const popperInstance = tooltipData.instance;

                    popperInstance.update();
                  });

                  target.setAttribute('title', targetTitle);

                  resolve(tooltipData);
                });
              },

              onUpdate: () => {
                this.setSpacing();
              },
            },
          });

          /* Add a class to the tooltip target */

          target.classList.add('ember-tooltip-target');

          this.addTargetEventListeners();
          this.set('_tooltip', tooltip);

          /* If user passes isShown=true, show the tooltip as soon as it's created */

          if (this.get('isShown')) {
            this.show();
          }
        });
      } catch(error) {
        reject(error);
      }
    });
  },

  setSpacing() {
    if (this._spacingRequestId || !this.get('isShown') || this.get('isDestroying')) {
      return;
    }

    this._spacingRequestId = requestAnimationFrame(() => {
      this._spacingRequestId = null;

      if (!this.get('isShown') || this.get('isDestroying')) {
        return;
      }

      const { popperInstance } = this.get('_tooltip');
      const { popper } = popperInstance;
      const side = popper.getAttribute('x-placement');
      const marginSide = getOppositeSide(side);
      const { style } = popper;

      style.marginTop = 0;
      style.marginRight = 0;
      style.marginBottom = 0;
      style.marginLeft = 0;

      popper.style[`margin${capitalize(marginSide)}`] = `${this.get('spacing')}px`;
    });
  },

  hide() {

    if (this.get('isDestroying')) {
      return;
    }

    /* If the tooltip is about to be showed by
    a delay, stop is being shown. */

    run.cancel(this.get('_showTimer'));

    this._hideTooltip();
  },

  show() {

    if (this.get('isDestroying')) {
      return;
    }

    const delay = this.get('delay');
    const duration = this.get('duration');

    run.cancel(this.get('_showTimer'));

    if (duration) {
      this.setHideTimer(duration);
    }

    if (delay) {
      this.setShowTimer(delay);
    } else {
      this._showTooltip();
    }
  },

  setHideTimer(duration) {
    duration = cleanNumber(duration);

    run.cancel(this.get('_hideTimer'));

    if (duration) {

      /* Hide tooltip after specified duration */

      const hideTimer = run.later(this, this.hide, duration);

      /* Save timer ID for canceling should an event
      hide the tooltip before the duration */

      this.set('_hideTimer', hideTimer);
    }
  },

  setShowTimer(delay) {
    delay = cleanNumber(delay);

    if (!this.get('delayOnChange')) {

      /* If the `delayOnChange` property is set to false, we
      don't want to delay opening this tooltip/popover if there is
      already a tooltip/popover shown in the DOM. Check that here
      and adjust the delay as needed. */

      let shownTooltipsOrPopovers = $(`.${ANIMATION_CLASS}`);

      if (shownTooltipsOrPopovers.length) {
        delay = 0;
      }
    }

    const _showTimer = run.later(this, () => {
      this._showTooltip();
    }, delay);

    this.set('_showTimer', _showTimer);
  },

  _hideTooltip() {
    const _tooltip = this.get('_tooltip');

    if (!_tooltip || this.get('isDestroying')) {
      return;
    }

    if (_tooltip.popperInstance) {
      _tooltip.popperInstance.popper.classList.remove(ANIMATION_CLASS);
    }

    run.later(() => {

      if (this.get('isDestroying')) {
        return;
      }

      cancelAnimationFrame(this._spacingRequestId);
      _tooltip.hide();

      this.set('_isHiding', false);
      this.set('isShown', false);
      this._dispatchAction('onHide', this);
    }, this.get('_animationDuration'));
  },

  _showTooltip() {

    if (this.get('isDestroying')) {
      return;
    }

    const _tooltip = this.get('_tooltip');

    _tooltip.show();

    this.set('isShown', true);

    run(() => {
      if (this.get('isDestroying')) {
        return;
      }

      _tooltip.popperInstance.popper.classList.add(ANIMATION_CLASS);

      this._dispatchAction('onShow', this);
    });
  },

  toggle() {

    /* We don't use toggleProperty because we centralize
    logic for showing and hiding in the show() and hide()
    methods. */

    if (this.get('isShown')) {
      this.hide();
    } else {
      this.show();
    }
  },

  _addEventListener(eventName, callback, element) {
    const target = element || this.get('target');

    /* Remember event listeners so they can removed on teardown */

    const boundCallback = run.bind(this, callback);

    this.get('_tooltipEvents').push({
      callback: boundCallback,
      target,
      eventName,
    });

    /* Add the event listeners */

    target.addEventListener(eventName, boundCallback);
  },

  _dispatchAction(actionName, ...args) {
    const action = this.get(actionName);

    if (!this.isDestroying && !this.isDestroyed && action) {
      action(...args);
    }
  },

  _cleanupTimers() {
    run.cancel(this.get('_showTimer'));
    cancelAnimationFrame(this._spacingRequestId);
  }
});

function mergeModifiers(defaults, overrides = {}) {
  const defaultKeys = Object.keys(defaults);
  const overriddenKeys = Object.keys(overrides);
  const keys = [].concat(defaultKeys, overriddenKeys).reduce((acc, key) => {
    if (!(acc.indexOf(key) !== 1)) acc.push(key);
    return acc;
  }, []);
  const modifiers = assign({}, defaults);

  for (const key of keys) {
    if ((defaultKeys.indexOf(key) !== 1) && (overriddenKeys.indexOf(key) !== 1)) {
      modifiers[key] = assign(
        {},
        defaults[key],
        overrides[key]
      );
    } else if (overriddenKeys.indexOf(key) !== 1) {
      modifiers[key] = overrides[key];
    }
  }

  return modifiers;
}
