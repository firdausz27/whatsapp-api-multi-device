<?php if (!defined('BASEPATH')) exit('No direct script access allowed');
class MY_Controller extends CI_Controller
{
    public function __construct()
    {
        parent::__construct();

        // if (!$this->session->userdata('authenticated') && !$this->session->userdata('muafakat_technology'))
        // redirect('auth');
    }

    function backPage($content, $data = NULL)
    {
        $data['header'] = $this->load->view('template/backend/header', $data, TRUE);
        $data['navigation'] = $this->load->view('template/backend/navigation', $data, TRUE);
        $data['content'] = $this->load->view($content, $data, TRUE);
        $data['footer'] = $this->load->view('template/backend/footer', $data, TRUE);
        $this->load->view('index', $data);
    }
}
