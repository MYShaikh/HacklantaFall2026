from django.contrib.auth.models import User
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from .models import normalize_number


class NormalizeTests(APITestCase):
    def test_normalize(self):
        self.assertEqual(normalize_number('(404) 555-0100'), '+14045550100')
        self.assertEqual(normalize_number('1-404-555-0100'), '+14045550100')
        self.assertEqual(normalize_number('+44 20 7946 0958'), '+442079460958')
        self.assertEqual(normalize_number('abc'), '')


class ApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user('alice', password='password123')
        self.token = Token.objects.create(user=self.user)

    def auth(self, token=None):
        self.client.credentials(HTTP_AUTHORIZATION=f'Token {(token or self.token).key}')

    def test_register_and_login(self):
        r = self.client.post('/api/auth/register/', {'username': 'bob', 'password': 'password123'})
        self.assertEqual(r.status_code, 201)
        self.assertIn('token', r.data)
        r = self.client.post('/api/auth/login/', {'username': 'bob', 'password': 'password123'})
        self.assertEqual(r.status_code, 200)

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/blocklist/').status_code, 401)

    def test_block_list_delete_and_duplicate(self):
        self.auth()
        r = self.client.post('/api/blocklist/', {'number': '(404) 555-0100', 'label': 'Spammer'})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.data['number'], '+14045550100')
        self.assertEqual(self.client.post('/api/blocklist/', {'number': '404-555-0100'}).status_code, 400)
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 1)
        self.assertEqual(self.client.delete(f"/api/blocklist/{r.data['id']}/").status_code, 204)
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 0)

    def test_unblock_all_only_clears_my_list(self):
        self.auth()
        for n in ('4045550101', '4045550102', '4045550103'):
            self.client.post('/api/blocklist/', {'number': n})
        other = User.objects.create_user('eve', password='password123')
        self.auth(Token.objects.create(user=other))
        self.client.post('/api/blocklist/', {'number': '4045550101'})

        self.auth()
        r = self.client.delete('/api/blocklist/')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, {'deleted': 3})
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 0)
        self.auth(Token.objects.get(user=other))
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 1)  # untouched

    def test_unblock_all_requires_auth(self):
        self.assertEqual(self.client.delete('/api/blocklist/').status_code, 401)

    def test_blocklists_are_per_user(self):
        self.auth()
        r = self.client.post('/api/blocklist/', {'number': '4045550100'})
        other = User.objects.create_user('eve', password='password123')
        self.auth(Token.objects.create(user=other))
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 0)
        self.assertEqual(self.client.delete(f"/api/blocklist/{r.data['id']}/").status_code, 404)

    def test_report_and_lookup(self):
        self.auth()
        self.assertEqual(self.client.post('/api/reports/', {'number': '4045550100', 'category': 'scam'}).status_code, 201)
        self.assertEqual(self.client.post('/api/reports/', {'number': '4045550100'}).status_code, 400)
        other = User.objects.create_user('eve', password='password123')
        self.auth(Token.objects.create(user=other))
        self.client.post('/api/reports/', {'number': '+14045550100', 'category': 'scam'})
        r = self.client.get('/api/lookup/', {'number': '(404) 555-0100'})
        self.assertEqual(r.data['report_count'], 2)
        self.assertEqual(r.data['top_category'], 'scam')

    def report_as(self, username, number, category='scam'):
        user = User.objects.create_user(username, password='password123')
        self.auth(Token.objects.create(user=user))
        self.client.post('/api/reports/', {'number': number, 'category': category})

    def test_spam_list_needs_two_reports_and_is_ranked(self):
        self.report_as('u1', '4045550101')                      # 1 report: not spam
        for i in range(3):
            self.report_as(f'a{i}', '4045550102', 'robocall')   # 3 reports
        for i in range(2):
            self.report_as(f'b{i}', '4045550103')               # 2 reports
        self.auth()
        r = self.client.get('/api/spam/')
        self.assertEqual([x['number'] for x in r.data], ['+14045550102', '+14045550103'])
        self.assertEqual(r.data[0]['report_count'], 3)
        self.assertEqual(r.data[0]['top_category'], 'robocall')
        self.assertEqual(len(self.client.get('/api/spam/', {'limit': 1}).data), 1)

    def test_spam_list_requires_auth(self):
        self.assertEqual(self.client.get('/api/spam/').status_code, 401)

    def test_bulk_lookup(self):
        self.report_as('u1', '4045550101')
        self.report_as('u2', '4045550101')
        self.auth()
        r = self.client.post('/api/lookup/bulk/', {'numbers': ['(404) 555-0101', '4045550999', 'junk']}, format='json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, {'+14045550101': {'report_count': 2, 'top_category': 'scam'}})
        self.assertEqual(self.client.post('/api/lookup/bulk/', {'numbers': 'x'}, format='json').status_code, 400)

    def test_scam_call_sync_logs_and_reports_once_without_blocking(self):
        self.auth()
        calls = [
            {'number': '(404) 555-0111', 'label': 'Scam Likely', 'called_at': 1760000000000},
            {'number': '4045550112', 'label': 'Potential Scam', 'called_at': 1760000100000},
            {'number': '4045550111', 'label': 'Scam Likely', 'called_at': 1760000200000},  # same number, later call
            {'number': 'junk', 'label': 'x', 'called_at': 1760000300000},
            {'number': '4045550113', 'label': 'x', 'called_at': 'not-a-time'},
        ]
        r = self.client.post('/api/scam-calls/sync/', {'calls': calls}, format='json')
        self.assertEqual(r.data, {'logged': 3, 'reported': 2})
        self.assertEqual(len(self.client.get('/api/blocklist/').data), 0)  # known spam is not auto-blocked
        self.assertEqual(len(self.client.get('/api/scam-calls/').data), 3)
        self.assertEqual(self.client.get('/api/lookup/', {'number': '4045550111'}).data['top_category'], 'scam')
        # Syncing the same calls again changes nothing.
        r = self.client.post('/api/scam-calls/sync/', {'calls': calls}, format='json')
        self.assertEqual(r.data, {'logged': 0, 'reported': 0})

    def test_scam_call_sync_does_not_duplicate_existing_report(self):
        self.auth()
        self.client.post('/api/reports/', {'number': '4045550111', 'category': 'spam'})
        r = self.client.post(
            '/api/scam-calls/sync/',
            {'calls': [{'number': '4045550111', 'label': 'Scam Likely', 'called_at': 1760000000000}]},
            format='json')
        self.assertEqual(r.data, {'logged': 1, 'reported': 0})

    def test_scam_call_sync_validates_and_is_per_user(self):
        self.assertEqual(self.client.post('/api/scam-calls/sync/', {'calls': []}, format='json').status_code, 401)
        self.auth()
        self.assertEqual(self.client.post('/api/scam-calls/sync/', {'calls': 'x'}, format='json').status_code, 400)
        self.client.post('/api/scam-calls/sync/',
                         {'calls': [{'number': '4045550111', 'label': 'Scam Likely', 'called_at': 1760000000000}]},
                         format='json')
        other = User.objects.create_user('eve', password='password123')
        self.auth(Token.objects.create(user=other))
        self.assertEqual(len(self.client.get('/api/scam-calls/').data), 0)

    def test_invalid_number_rejected(self):
        self.auth()
        self.assertEqual(self.client.post('/api/reports/', {'number': 'abc'}).status_code, 400)
