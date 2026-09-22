import importlib.util, pathlib, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('broker',pathlib.Path(__file__).with_name('service.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
A='11111111-1111-4111-8111-111111111111'
B='22222222-2222-4222-8222-222222222222'
class BrokerTests(unittest.TestCase):
 def test_idle_stops_only_expired_lease(self):
  b.LEASES.clear();b.LEASES.update({A:0,B:950})
  with patch.object(b.time,'monotonic',return_value=1000),patch.object(b,'docker') as docker:
   b.reap_once();docker.assert_called_once_with('stop','--time','15','desktop-'+A)
   self.assertEqual(list(b.LEASES),[B])
 def test_capacity_blocks_before_allocating_disk(self):
  original=pathlib.Path.read_text
  def read(p,*a,**k):
   if str(p).endswith('/memory.max'):return '17179869184'
   if str(p).endswith('/cpu.max'):return '300000 100000'
   return original(p,*a,**k)
  with tempfile.TemporaryDirectory() as d,patch.object(b,'ROOT',pathlib.Path(d)),patch.object(pathlib.Path,'read_text',read),patch.object(b,'run',return_value='172.30.50.0/28 172.30.50.2'),patch.object(b,'state',return_value=None),patch.object(b,'docker',return_value='container1 container2'):
   with self.assertRaises(b.Capacity):b.ensure(A)
   self.assertEqual(list(pathlib.Path(d).iterdir()),[])
 def test_missing_aggregate_limit_fails_closed(self):
  with tempfile.TemporaryDirectory() as d,patch.object(b,'ROOT',pathlib.Path(d)),patch.object(pathlib.Path,'read_text',return_value='max'),patch.object(b,'docker') as docker:
   with self.assertRaises(b.Capacity):b.ensure(A)
   docker.assert_not_called()
if __name__=='__main__':unittest.main()
