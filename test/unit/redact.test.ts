import { describe, expect, it } from 'vitest';
import { redactBody, redactTarget, secretName } from '../../src/redact.ts';

describe('redact', () => {
  it('reads a run-together name by its ending, and leaves names that only contain a secret’s letters', () => {
    for (const n of ['dbpassword', 'DB_PWD', 'csrftoken', 'ClientSecret', 'apikey'])
      expect(secretName(n)).toBe(true);
    for (const n of ['passenger', 'bypass', 'tokenizer', 'two_signature_threshold', 'secretary'])
      expect(secretName(n)).toBe(false);
  });

  it('redacts a report server’s SOAP parameters, XML elements and attributes', () => {
    const soap =
      '<soap:Body><Render><Parameters>' +
      '<ParameterValue><Name>UserName</Name><Value>report_reader</Value></ParameterValue>' +
      '<ParameterValue><Name>Password</Name><Value>hunter2</Value></ParameterValue>' +
      '</Parameters><ns:dbPassword type="s">hunter3</ns:dbPassword><Login user="r" password="hunter4"/>' +
      '</Render></soap:Body>';
    const out = redactBody(soap, 'text/xml');
    expect(out).not.toMatch(/hunter/);
    expect(out).toContain('<Name>UserName</Name><Value>report_reader</Value>');
    expect(out).toContain('<Name>Password</Name><Value>[redacted]</Value>');
    expect(out).toContain('<ns:dbPassword type="s">[redacted]</ns:dbPassword>');
    expect(out).toContain('<Login user="r" password="[redacted]"/>');
  });

  it('redacts a name/value pair in JSON, JSON cut short, and a form with no content type', () => {
    expect(
      JSON.parse(redactBody('[{"name":"Password","value":"hunter2"},{"name":"Site","value":"North"}]')),
    ).toEqual([
      { name: 'Password', value: '[redacted]' },
      { name: 'Site', value: 'North' },
    ]);
    expect(redactBody('{"user":"ana","password":"hunter2","note":"a long note that was cu')).toBe(
      '{"user":"ana","password":"[redacted]","note":"a long note that was cu',
    );
    expect(redactBody('{"user":"ana","password":"hunt')).toBe('{"user":"ana","password":"[redacted]');
    expect(redactBody('rs:Command=Render&UserName=r&Password=hunter2')).toBe(
      'rs:Command=Render&UserName=r&Password=[redacted]',
    );
    expect(redactBody('Hello there, a=b and c')).toBe('Hello there, a=b and c');
  });

  it('redacts a request’s query and leaves a word that is not a path alone', () => {
    expect(redactTarget('/ReportServer?rs:Command=Render&pwd=hunter2&id=4')).toBe(
      '/ReportServer?rs%3ACommand=Render&pwd=[redacted]&id=4',
    );
    expect(redactTarget('http://north.sample.test/hook?token=abc')).toBe(
      'http://north.sample.test/hook?token=[redacted]',
    );
    expect(redactTarget('mailbox')).toBe('mailbox');
  });
});
