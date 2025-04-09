// helpers.js
import config from '../utils/configuration.js';

export function roundDownToTwoDecimals(number) {
  return Math.floor(number * 100) / 100;
}

export function calculateBidAmount(exchange) {
  const rawValue = exchange.accountInfo.walletBalance * config.current.bidPercentage / 100;
  return roundDownToTwoDecimals(rawValue);
}

export function getOppositeTradeSide(tradeSide) {
  return tradeSide === 'BUY' ? 'SELL' : 'BUY';
}

export function translatePositionSideToTradeSide(positionSide) {
  return positionSide === 'LONG' ? 'BUY' : 'SELL';
}

export function getTokenTrend(liquidationSide) {
  return liquidationSide === 'BUY' ? 'Most likely UP-trend' : 'Most likely DOWN-trend';
}

export function getBotTradeSide(liquidationSide) {
  if (config.current.tradeDirection === 'trend') {
    return liquidationSide;
  } else if (config.current.tradeDirection === 'rebound') {
    return getOppositeTradeSide(liquidationSide);
  }
}

export function getPercentChange(start, end) {
  if (typeof start !== 'number' || typeof end !== 'number' || start === 0) return 0;
  return ((end - start) / start) * 100;
}

export function getCurrentTimestamp() {
  const now = new Date();
  return now.toLocaleString('en-GB', {
    timeZone: 'Europe/Budapest',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(',', '');
}

export default {
  roundDownToTwoDecimals,
  calculateBidAmount,
  getOppositeTradeSide,
  translatePositionSideToTradeSide,
  getTokenTrend,
  getBotTradeSide,
  getPercentChange,
  getCurrentTimestamp
};